import type { Promisable } from "@aidc-toolkit/core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import { setTimeout } from "node:timers/promises";
import { Octokit } from "octokit";
import { parse as yamlParse } from "yaml";
import secureConfigurationJSON from "../config/publisher.secure.json" with { type: "json" };
import { SHARED_CONFIGURATION_PATH } from "./configuration.js";
import { NEXT_PHASE, type Phase, PREVIOUS_PHASE } from "./phase.js";
import { Publisher, RunOptions } from "./publisher.js";

/**
 * Configuration layout of publisher.secure.json.
 */
interface SecureConfiguration {
    /**
     * Token.
     */
    token: string;
}

/**
 * Configuration layout of release.yml workflow (relevant attributes only).
 */
interface WorkflowConfiguration {
    /**
     * Workflow name.
     */
    name: string;

    /**
     * Workflow trigger.
     */
    on: {
        /**
         * Push trigger.
         */
        push?: {
            /**
             * Push branches.
             */
            branches?: string[];
        } | null;

        /**
         * Release trigger.
         */
        release?: {
            /**
             * Release types.
             */
            types?: string[];
        } | null;
    };
}

/**
 * Publication steps.
 */
type Step = "install" | "build" | "commit" | "tag" | "push" | "workflow (push)" | "release" | "workflow (release)" | "pull request" | "npm wait";

/**
 * Job states.
 */
type JobState = "waiting" | "running" | "complete";

/**
 * Non-alpha release publisher.
 */
class NonAlphaPublisher extends Publisher<Exclude<Phase, "alpha">> {
    /**
     * Secure configuration.
     */
    readonly #secureConfiguration: SecureConfiguration = secureConfigurationJSON;

    /**
     * Octokit.
     */
    #octokit!: Octokit;

    /**
     * @inheritDoc
     */
    protected override dependencyVersionFor(dependencyRepositoryName: string): string {
        const dependencyType = this.configuration.repositories[dependencyRepositoryName].dependencyType;

        const dependencyVersion = this.getPhaseState(dependencyRepositoryName).version;

        let dependencyVersionRange: string;

        switch (dependencyType) {
            case "external":
                // Lock to version against which package was developed if not in production.
                dependencyVersionRange = this.phase !== "prod" ? dependencyVersion : `^${dependencyVersion}`;
                break;

            case "internal":
                // Tag is the version preceded by 'v'.
                dependencyVersionRange = `${this.configuration.organization}/${dependencyRepositoryName}#v${dependencyVersion}`;
                break;

            default:
                throw new Error(`Invalid dependency type "${(dependencyType)}" for dependency ${dependencyRepositoryName}`);
        }

        return dependencyVersionRange;
    }

    /**
     * @inheritDoc
     */
    protected override isValidRepositoryChange(): boolean {
        return false;
    }

    /**
     * @inheritDoc
     */
    protected override isValidBranch(): boolean {
        const parsedVersion = this.repository.parsedVersion;

        // Branch for non-alpha phase must match version.
        return this.branch === `v${parsedVersion.majorVersion}.${parsedVersion.minorVersion}`;
    }

    /**
     * Run a step.
     *
     * Repository.
     *
     * @param step
     * State at which step takes place.
     *
     * @param stepRunner
     * Callback to execute step.
     */
    async #runStep(step: Step, stepRunner: () => Promisable<unknown>): Promise<void> {
        const publishState = this.configuration.publishState;

        const publishStateStep = publishState.step;

        if (publishStateStep === undefined || publishStateStep === step) {
            this.logger.debug(`Running step ${step}`);

            publishState.step = step;

            await stepRunner();

            delete publishState.step;
        } else {
            this.logger.debug(`Skipping step ${step}`);
        }
    }

    /**
     * Run a job. Waits up to five minutes for job to start and then runs until complete.
     *
     * @param jobRunner
     * Job runner.
     *
     * @param timeoutMessage
     * Error message to throw if timed out waiting for job to start.
     */
    async #runJob(jobRunner: () => Promisable<JobState>, timeoutMessage: string): Promise<void> {
        let wasRunning = false;
        let complete = false;

        const timeout = Date.now() + 5 * 60 * 1000;

        do {
            // eslint-disable-next-line no-await-in-loop,@typescript-eslint/no-implied-eval -- Loop depends on awaited response.
            switch (await setTimeout(2000).then(jobRunner)) {
                case "waiting":
                    // Abort if job still waiting after five minutes.
                    if (Date.now() > timeout) {
                        throw new Error(timeoutMessage);
                    }
                    break;

                case "running":
                    wasRunning = true;
                    process.stdout.write(".");
                    break;

                case "complete":
                    complete = true;
                    break;
            }
        } while (!complete);

        if (wasRunning) {
            process.stdout.write("\n");
        }
    }

    /**
     * Validate the workflow by waiting for it to complete.
     */
    async #validateWorkflow(): Promise<void> {
        if (this.isDryRun) {
            this.logger.info("Dry run: Validate workflow");
        } else {
            const commitSHA = this.run(RunOptions.RunAlways, true, false, "git", "rev-parse", this.branch)[0];

            let workflowRunID = -1;

            await this.#runJob(async () =>
                this.#octokit.rest.actions.listWorkflowRunsForRepo({
                    owner: this.configuration.organization,
                    repo: this.repository.name,
                    head_sha: commitSHA
                }).then((response) => {
                    let jobState: JobState = "waiting";

                    for (const workflowRun of response.data.workflow_runs) {
                        if (workflowRun.status !== "completed") {
                            jobState = "running";

                            if (workflowRunID === -1) {
                                workflowRunID = workflowRun.id;

                                this.logger.info(`Workflow run ID ${workflowRunID}`);
                            } else if (workflowRun.id !== workflowRunID) {
                                throw new Error(`Parallel workflow runs for SHA ${commitSHA}`);
                            }
                        } else if (workflowRun.id === workflowRunID) {
                            if (workflowRun.conclusion !== "success") {
                                throw new Error(`Workflow ${workflowRun.conclusion}`);
                            }

                            jobState = "complete";
                        }
                    }

                    return jobState;
                }), `Workflow run not started for SHA ${commitSHA}`);
        }
    }

    /**
     * @inheritDoc
     */
    protected override async initialize(): Promise<void> {
        await super.initialize();

        this.#octokit = new Octokit({
            auth: this.#secureConfiguration.token,
            userAgent: `${this.configuration.organization} publisher`
        });
    }

    /**
     * @inheritDoc
     */
    protected override async publish(): Promise<void> {
        const repository = this.repository;
        const branch = this.branch;
        const parsedVersion = repository.parsedVersion;

        const phase = this.phase;
        const publishState = this.configuration.publishState;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Non-alpha phases have non-null previous phase.
        const previousPhase = PREVIOUS_PHASE[phase]!;
        const nextPhase = NEXT_PHASE[phase];
        const preReleasePhase = parsedVersion.preReleaseIdentifier ?? "prod";

        let skip = false;

        if (preReleasePhase === previousPhase) {
            if (this.anyChanges(repository.versionState.phaseStates[previousPhase]?.dateTime)) {
                throw new Error(`Repository has changed since last ${previousPhase} published`);
            }

            // Production version has no pre-release identifier.
            repository.updatePackageVersion(true, parsedVersion.majorVersion, parsedVersion.minorVersion, parsedVersion.patchVersion, phase !== "prod" ? phase : undefined);

            // Alpha phase uses separate registry.
            if (previousPhase === "alpha") {
                this.unsetOrganizationAlphaRegistry();

                // Patch package-lock.json with default registry in case some beta versions were installed indirectly.
                this.run(RunOptions.SkipOnDryRun, false, false, "sed", "-i", "", "-e", `s/${this.configuration.alphaRegistry.replace(/(?<c>[./])/ug, "\\$<c>")}/https:\\/\\/registry\\.npmjs\\.org\\//`, "package-lock.json");
            }
        } else if (preReleasePhase === phase) {
            // Ignore changes after publication process has started.
            if (publishState.step === undefined) {
                if (this.anyChanges(this.getPhaseDateTime())) {
                    throw new Error(`Repository has changed since last ${phase} published`);
                }

                // No changes since previous publication of this phase.
                skip = true;
            }
        } else if (preReleasePhase === nextPhase) {
            // No changes since publication of next phase.
            skip = true;
        } else {
            throw new Error(`Pre-release identifier must be ${previousPhase}, ${phase}, or ${nextPhase}`);
        }

        if (!skip) {
            const packageConfiguration = repository.packageConfiguration;
            const version = packageConfiguration.version;
            const tag = `v${version}`;

            if (publishState.step !== undefined) {
                this.logger.debug(`Repository failed at step "${publishState.step}" on prior run`);
            }

            const workflowsPath = ".github/workflows/";

            let hasPushWorkflow = false;
            let hasReleaseWorkflow = false;

            if (fs.existsSync(workflowsPath)) {
                this.logger.debug("Checking workflows");

                for (const workflowFile of fs.readdirSync(workflowsPath).filter(workflowFile => workflowFile.endsWith(".yml"))) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Workflow configuration format is known.
                    const workflowOn = (yamlParse(fs.readFileSync(path.resolve(workflowsPath, workflowFile)).toString()) as WorkflowConfiguration).on;

                    if (workflowOn.push !== undefined && (workflowOn.push?.branches === undefined || workflowOn.push.branches.includes("v*"))) {
                        this.logger.debug("Repository has push workflow");

                        hasPushWorkflow = true;
                    }

                    if (workflowOn.release !== undefined && (workflowOn.release?.types === undefined || workflowOn.release.types.includes("published"))) {
                        this.logger.debug("Repository has release workflow");

                        hasReleaseWorkflow = true;
                    }
                }
            }

            await this.#runStep("install", () => {
                this.updatePackageLockConfiguration();
            });

            await this.#runStep("build", () => {
                this.run(RunOptions.SkipOnDryRun, false, false, "npm", "run", `build:${phase}`, "--if-present");
            });

            await this.#runStep("commit", () => {
                this.commitModified(`Updated to version ${this.repository.packageConfiguration.version}.`);
            });

            await this.#runStep("tag", () => {
                this.run(RunOptions.SkipOnDryRun, false, false, "git", "tag", tag);
            });

            await this.#runStep("push", () => {
                this.run(RunOptions.SkipOnDryRun, false, false, "git", "push", "--atomic", "origin", branch, tag);
            });

            if (hasPushWorkflow) {
                await this.#runStep("workflow (push)", async () =>
                    this.#validateWorkflow()
                );
            }

            // Helper repositories don't publish releases.
            if (repository.dependencyType !== "helper") {
                if (this.isDryRun) {
                    this.logger.info("Dry run: Create release");
                } else {
                    await this.#runStep("release", async () =>
                        this.#octokit.rest.repos.createRelease({
                            owner: this.configuration.organization,
                            repo: this.repository.name,
                            tag_name: tag,
                            name: `Release ${tag}`,
                            prerelease: phase !== "prod"
                        })
                    );
                }

                if (hasReleaseWorkflow) {
                    await this.#runStep("workflow (release)", async () =>
                        this.#validateWorkflow()
                    );
                }
            }

            // Pull requests apply only to production publication when the next branch is main; version-to-version propagation requires manual rebase.
            if (phase === "prod" && this.getNextBranch() === "main") {
                await this.#runStep("pull request", async () => {
                    if (this.isDryRun) {
                        this.logger.info(`Dry run: Pull request from ${branch} to main`);
                    } else {
                        await this.#octokit.rest.pulls.create({
                            owner: this.configuration.organization,
                            repo: this.repository.name,
                            title: `Production version ${version}`,
                            head: branch,
                            base: "main"
                        });
                    }
                });
            }

            // External repositories need to give the NPM registry time to reindex.
            if (repository.dependencyType === "external") {
                if (this.isDryRun) {
                    this.logger.info("Dry run: NPM wait");
                } else {
                    const packageSpecification = `${packageConfiguration.name}@${phase === "beta" ? "beta" : "latest"}`;

                    await this.#runStep("npm wait", async () =>
                        this.#runJob(() =>
                            this.run(RunOptions.RunAlways, true, true, "npm", "view", packageSpecification, "version")[0] === version ? "complete" : "waiting", "NPM package publication not completed"
                        )
                    );
                }
            }

            repository.updatePhaseDateTime();
        }
    }

    /**
     * @inheritDoc
     */
    protected override async finalize(): Promise<void> {
        this.commitModified(`Published ${this.phase} release.`, SHARED_CONFIGURATION_PATH);

        const version = this.getPhaseState().version;

        const tag = `v${version}`;

        // Move local tag to latest commit.
        this.run(RunOptions.SkipOnDryRun, false, false, "git", "tag", "--delete", tag);
        this.run(RunOptions.SkipOnDryRun, false, false, "git", "tag", tag);

        // Delete remote tag and push latest commit and updated tag to remote.
        this.run(RunOptions.SkipOnDryRun, false, false, "git", "push", "--atomic", "--delete", "origin", tag);
        this.run(RunOptions.SkipOnDryRun, false, false, "git", "push", "--atomic", "origin", this.branch, tag);

        await super.finalize();
    }
}

const phase = process.argv[2];

if (phase !== "beta" && phase !== "prod") {
    throw new Error(`Invalid phase ${phase}`);
}

// Detailed syntax checking not required as this is an internal tool.
const publisher = new NonAlphaPublisher(phase, process.argv.includes("--dry-run"));

publisher.publishAll().catch((e: unknown) => {
    publisher.logger.error("Publisher failed", e);
    process.exit(1);
});
