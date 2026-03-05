import type { Promisable } from "@aidc-toolkit/core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import { setTimeout } from "node:timers/promises";
import { Octokit } from "octokit";
import { parse as yamlParse } from "yaml";
import secureConfigurationJSON from "../config/publisher.secure.json" with { type: "json" };
import { NEXT_PHASE, type Phase, PREVIOUS_PHASE, SHARED_CONFIGURATION_PATH } from "./configuration.js";
import { Publisher, RunOptions } from "./publisher.js";

/**
 * Configuration layout of publisher.secure.json.
 */
interface SecureConfiguration {
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
export class NonAlphaPublisher extends Publisher {
    /**
     * Secure configuration.
     */
    readonly #secureConfiguration: SecureConfiguration = secureConfigurationJSON;

    /**
     * Octokit.
     */
    readonly #octokit: Octokit;

    /**
     * Constructor.
     *
     * @param phase
     * Phase, excluding alpha.
     *
     * @param dryRun
     * If true, output what would be run rather than running it.
     */
    constructor(phase: Exclude<Phase, "alpha">, dryRun: boolean) {
        super(phase, dryRun);

        this.#octokit = new Octokit({
            auth: this.#secureConfiguration.token,
            userAgent: `${this.configuration.organization} publisher`
        });
    }

    /**
     * @inheritDoc
     */
    protected override dependencyVersionFor(dependencyRepositoryName: string): string {
        const dependencyRepository = this.configuration.repositories[dependencyRepositoryName];

        const phaseStateVersion = dependencyRepository.phaseStates[this.phase]?.version;

        if (phaseStateVersion === undefined) {
            throw new Error(`*** Internal error *** Version not set for dependency ${dependencyRepositoryName}`);
        }

        let dependencyVersion: string;

        switch (dependencyRepository.dependencyType) {
            case "external":
                // Lock to version against which package was developed if not in production.
                dependencyVersion = this.phase !== "prod" ? phaseStateVersion : `^${phaseStateVersion}`;
                break;

            case "internal":
                // Tag is the version preceded by 'v'.
                dependencyVersion = `${this.configuration.organization}/${dependencyRepositoryName}#v${phaseStateVersion}`;
                break;

            default:
                throw new Error(`Invalid dependency type "${(dependencyRepository.dependencyType)}" for dependency ${dependencyRepositoryName}`);
        }

        return dependencyVersion;
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
        const repositoryPublishState = this.repositoryPublishState;

        // Branch for non-alpha phase must match version for anything other than helper repository.
        return repositoryPublishState.repository.dependencyType === "helper" || repositoryPublishState.branch === `v${repositoryPublishState.majorVersion}.${repositoryPublishState.minorVersion}`;
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
        const publishStateStep = this.publishState.step;

        if (publishStateStep === undefined || publishStateStep === step) {
            this.logger.debug(`Running step ${step}`);

            this.publishState.step = step;

            await stepRunner();

            delete this.publishState.step;
        } else {
            this.logger.debug(`Skipping step ${step}`);
        }
    }

    /**
     * Run a job. Waits up to 20 seconds for job to start and then runs until complete.
     *
     * @param jobRunner
     * Job runner.
     *
     * @param timeoutMessage
     * Error message to throw if timed out waiting for job to start.
     */
    async #runJob(jobRunner: () => Promisable<JobState>, timeoutMessage: string): Promise<void> {
        let waitCount = 0;
        let wasRunning = false;
        let complete = false;

        do {
            // eslint-disable-next-line no-await-in-loop,@typescript-eslint/no-implied-eval -- Loop depends on awaited response.
            switch (await setTimeout(2000).then(jobRunner)) {
                case "waiting":
                    // Abort if job still waiting after two minutes.
                    if (++waitCount === 60) {
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
        if (this.dryRun) {
            this.logger.info("Dry run: Validate workflow");
        } else {
            const commitSHA = this.run(RunOptions.RunAlways, true, false, "git", "rev-parse", this.repositoryPublishState.branch)[0];

            let workflowRunID = -1;

            await this.#runJob(async () =>
                this.#octokit.rest.actions.listWorkflowRunsForRepo({
                    owner: this.configuration.organization,
                    repo: this.repositoryPublishState.repositoryName,
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
    protected override async publish(): Promise<void> {
        const repositoryPublishState = this.repositoryPublishState;
        const repository = repositoryPublishState.repository;
        const branch = repositoryPublishState.branch;
        const preReleaseIdentifier = repositoryPublishState.preReleaseIdentifier;

        const phase = this.phase;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Only alpha has a null previous phase.
        const previousPhase = PREVIOUS_PHASE[phase]!;
        const nextPhase = NEXT_PHASE[phase];
        const preReleasePhase = preReleaseIdentifier ?? "prod";

        let skip = false;

        if (preReleasePhase === previousPhase) {
            if (this.anyChanges(repository.phaseStates[previousPhase]?.dateTime)) {
                throw new Error(`Repository has changed since last ${previousPhase} published`);
            }

            // Production version has no pre-release identifier.
            const version = this.updatePackageVersion(undefined, undefined, undefined, phase !== "prod" ? phase : null);

            if (repository.dependencyType === "external" || repository.dependencyType === "internal") {
                // Save version to be picked up by dependents.
                this.updatePhaseState({
                    version
                });
            }

            // Alpha phase uses local registry.
            if (previousPhase === "alpha") {
                this.run(RunOptions.SkipOnDryRun, false, false, "npm", "config", "delete", this.atOrganizationRegistry, "--location", "project");
            }
        } else if (preReleasePhase === phase) {
            // Ignore changes after publication process has started.
            if (this.publishState.step === undefined) {
                if (this.anyChanges(repository.phaseStates[phase]?.dateTime)) {
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
            const packageConfiguration = repositoryPublishState.packageConfiguration;
            const version = packageConfiguration.version;
            const tag = `v${version}`;

            if (this.publishState.step !== undefined) {
                this.logger.debug(`Repository failed at step "${this.publishState.step}" on prior run`);
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
                this.commitUpdatedPackageVersion();
            });

            // Helper repositories don't use tags.
            if (repository.dependencyType !== "helper") {
                await this.#runStep("tag", () => {
                    this.run(RunOptions.SkipOnDryRun, false, false, "git", "tag", tag);
                });
            }

            await this.#runStep("push", () => {
                this.run(RunOptions.ParameterizeOnDryRun, false, false, "git", "push", "--atomic", "origin", branch, ...repository.dependencyType !== "helper" ? [tag] : []);
            });

            if (hasPushWorkflow) {
                await this.#runStep("workflow (push)", async () =>
                    this.#validateWorkflow()
                );
            }

            // Helper repositories don't publish releases.
            if (repository.dependencyType !== "helper") {
                if (this.dryRun) {
                    this.logger.info("Dry run: Create release");
                } else {
                    await this.#runStep("release", async () =>
                        this.#octokit.rest.repos.createRelease({
                            owner: this.configuration.organization,
                            repo: repositoryPublishState.repositoryName,
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

            // Helper repositories don't have version flow.
            if (repository.dependencyType !== "helper" && phase === "prod") {
                await this.#runStep("pull request", async () =>
                    this.#octokit.rest.pulls.create({
                        owner: this.configuration.organization,
                        repo: repositoryPublishState.repositoryName,
                        title: `Production version ${version}`,
                        head: branch,
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Branch is known to be a version branch.
                        base: this.getNextBranch()!
                    })
                );
            }

            // External repositories need to give the NPM registry time to reindex.
            if (repository.dependencyType === "external") {
                if (this.dryRun) {
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

            this.updatePhaseState({
                dateTime: new Date()
            });
        }
    }

    /**
     * @inheritDoc
     */
    protected override finalize(): void {
        super.finalize();

        this.commitModified(`Published ${this.phase} release.`, SHARED_CONFIGURATION_PATH);

        this.run(RunOptions.ParameterizeOnDryRun, false, false, "git", "push", "--atomic", "origin", this.repositoryPublishState.branch);
    }
}

const phase = process.argv[2];

if (phase !== "beta" && phase !== "prod") {
    throw new Error(`Invalid phase ${phase}`);
}

// Detailed syntax checking not required as this is an internal tool.
const publisher = new NonAlphaPublisher(phase, process.argv.includes("--dry-run"));

publisher.publishAll().catch((e: unknown) => {
    publisher.logger.error(e);
    process.exit(1);
});
