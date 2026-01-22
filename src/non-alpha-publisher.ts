import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { Octokit } from "octokit";
import { parse as yamlParse } from "yaml";
import secureConfigurationJSON from "../config/publisher.secure.json" with { type: "json" };
import { type Phase, PREVIOUS_PHASE } from "./configuration.js";
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
     * If true, outputs what would be run rather than running it.
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
    async #runStep(step: Step, stepRunner: () => unknown): Promise<void> {
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
     * Validate the workflow by waiting for it to complete.
     *
     * Branch on which workflow is running.
     */
    async #validateWorkflow(): Promise<void> {
        if (this.dryRun) {
            this.logger.info("Dry run: Validate workflow");
        } else {
            const commitSHA = this.run(RunOptions.RunAlways, true, "git", "rev-parse", this.repositoryPublishState.branch)[0];

            let completed = false;
            let queryCount = 0;
            let workflowRunID = -1;

            do {
                // eslint-disable-next-line no-await-in-loop -- Loop depends on awaited response.
                const response = await setTimeout(2000).then(async () =>
                    this.#octokit.rest.actions.listWorkflowRunsForRepo({
                        owner: this.configuration.organization,
                        repo: this.repositoryPublishState.repositoryName,
                        head_sha: commitSHA
                    })
                );

                for (const workflowRun of response.data.workflow_runs) {
                    if (workflowRun.status !== "completed") {
                        if (workflowRun.id === workflowRunID) {
                            process.stdout.write(".");
                        } else if (workflowRunID === -1) {
                            workflowRunID = workflowRun.id;

                            this.logger.info(`Workflow run ID ${workflowRunID}`);
                        } else {
                            throw new Error(`Parallel workflow runs for SHA ${commitSHA}`);
                        }
                    } else if (workflowRun.id === workflowRunID) {
                        process.stdout.write("\n");

                        if (workflowRun.conclusion !== "success") {
                            throw new Error(`Workflow ${workflowRun.conclusion}`);
                        }

                        completed = true;
                    }
                }

                // Abort if workflow run not started after 10 queries.
                if (++queryCount === 10 && workflowRunID === -1) {
                    throw new Error(`Workflow run not started for SHA ${commitSHA}`);
                }
            } while (!completed);
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

        let skip = false;

        if (preReleaseIdentifier === previousPhase) {
            if (this.anyChanges(repository.phaseStates[previousPhase]?.dateTime, false)) {
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
                this.run(RunOptions.SkipOnDryRun, false, "npm", "config", "delete", this.atOrganizationRegistry, "--location", "project");
            }
        } else if (preReleaseIdentifier === phase) {
            // Ignore changes after publication process has started.
            if (this.publishState.step === undefined) {
                if (this.anyChanges(repository.phaseStates[phase]?.dateTime, false)) {
                    throw new Error(`Repository has changed since last ${phase} published`);
                }

                // No changes since previous publication of this phase.
                skip = true;
            }
        } else {
            throw new Error(`Pre-release identifier must be either ${previousPhase} or ${phase}`);
        }

        if (!skip) {
            const tag = `v${repositoryPublishState.packageConfiguration.version}`;

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
                this.run(RunOptions.SkipOnDryRun, false, "npm", "run", `build:${phase}`, "--if-present");
            });

            await this.#runStep("commit", () => {
                this.commitUpdatedPackageVersion();
            });

            // Helper repositories don't use tags.
            if (repository.dependencyType !== "helper") {
                await this.#runStep("tag", () => {
                    this.run(RunOptions.SkipOnDryRun, false, "git", "tag", tag);
                });
            }

            await this.#runStep("push", () => {
                this.run(RunOptions.ParameterizeOnDryRun, false, "git", "push", "--atomic", "origin", branch, ...repository.dependencyType !== "helper" ? [tag] : []);
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
                // Branch is version preceded by 'v'.
                const branchVersionIndex = this.configuration.versions.indexOf(branch.substring(1));
                const nextBranch = branchVersionIndex !== this.configuration.versions.length - 1 ?
                    `v${this.configuration.versions[branchVersionIndex + 1]}` :
                    "main";

                await this.#runStep("pull request", async () =>
                    this.#octokit.rest.pulls.create({
                        owner: this.configuration.organization,
                        repo: repositoryPublishState.repositoryName,
                        title: `Production version ${repositoryPublishState.packageConfiguration.version}`,
                        head: branch,
                        base: nextBranch
                    })
                );
            }

            // External repositories need to give the NPM registry time to reindex.
            if (repository.dependencyType === "external") {
                await this.#runStep("npm wait", async () =>
                    setTimeout(10000)
                );
            }

            this.updatePhaseState({
                dateTime: new Date()
            });
        }
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
