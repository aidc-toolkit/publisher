import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout } from "node:timers/promises";
import { Octokit } from "octokit";
import { parse as yamlParse } from "yaml";
import secureConfigurationJSON from "../config/publish.secure.json";
import type { Repository } from "./configuration";
import { Publish } from "./publish";
import { logger } from "./logger";

/**
 * Configuration layout of publish.secure.json.
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
 * Publish steps.
 */
type Step = "update" | "build" | "commit" | "tag" | "push" | "workflow (push)" | "release" | "workflow (release)" | "complete";

/**
 * Publish beta versions.
 */
class PublishBeta extends Publish {
    /**
     * Secure configuration.
     */
    private readonly _secureConfiguration: SecureConfiguration = secureConfigurationJSON;

    /**
     * Octokit.
     */
    private readonly _octokit: Octokit;

    /**
     * Constructor.
     *
     * @param dryRun
     * If true, outputs what would be run rather than running it.
     */
    constructor(dryRun: boolean) {
        super("beta", dryRun);

        this._octokit = new Octokit({
            auth: this._secureConfiguration.token,
            userAgent: `${this.configuration.organization} release`
        });
    }

    /**
     * @inheritDoc
     */
    protected dependencyVersionFor(dependencyRepositoryName: string, dependencyRepository: Repository): string {
        let dependencyVersion: string;

        switch (dependencyRepository.dependencyType) {
            case "external":
                dependencyVersion = "beta";
                break;

            case "internal": {
                const betaTag = dependencyRepository.phaseStates.beta?.tag;

                if (betaTag === undefined) {
                    throw new Error(`*** Internal error *** Beta tag not set for ${dependencyRepositoryName}`);
                }

                dependencyVersion = `${this.configuration.organization}/${dependencyRepositoryName}#${betaTag}`;
            }
                break;

            default:
                throw new Error(`Invalid dependency type "${dependencyRepository.dependencyType}" for dependency ${dependencyRepositoryName}`);
        }

        return dependencyVersion;
    }

    /**
     * @inheritDoc
     */
    protected override getPhaseDateTime(repository: Repository, phaseDateTime: Date): Date;

    /**
     * @inheritDoc
     */
    protected override getPhaseDateTime(repository: Repository, phaseDateTime: Date | undefined): Date | undefined {
        return this.latestDateTime(phaseDateTime, repository.phaseStates.production?.dateTime);
    }

    /**
     * @inheritDoc
     */
    protected isValidBranch(): boolean {
        const repositoryState = this.repositoryState;

        // Branch for beta phase must match version.
        return repositoryState.branch === `v${repositoryState.majorVersion}.${repositoryState.minorVersion}`;
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
    private async runStep(step: Step, stepRunner: () => (void | Promise<void>)): Promise<void> {
        const phaseStateStep = this.repositoryState.phaseState.step;

        if (phaseStateStep === undefined || phaseStateStep === step) {
            logger.debug(`Running step ${step}`);

            this.updatePhaseState({
                step
            });

            await stepRunner();

            this.updatePhaseState({
                step: undefined
            });
        } else {
            logger.debug(`Skipping step ${step}`);
        }
    }

    /**
     * Validate the workflow by waiting for it to complete.
     *
     * Branch on which workflow is running.
     */
    private async validateWorkflow(): Promise<void> {
        if (this.dryRun) {
            logger.info("Dry run: Validate workflow");
        } else {
            const commitSHA = this.run(true, true, "git", "rev-parse", this.repositoryState.branch)[0];

            let completed = false;
            let queryCount = 0;
            let workflowRunID = -1;

            do {
                // eslint-disable-next-line no-await-in-loop -- Loop depends on awaited response.
                const response = await setTimeout(2000).then(
                    async () => this._octokit.rest.actions.listWorkflowRunsForRepo({
                        owner: this.configuration.organization,
                        repo: this.repositoryState.repositoryName,
                        head_sha: commitSHA
                    })
                );

                for (const workflowRun of response.data.workflow_runs) {
                    if (workflowRun.status !== "completed") {
                        if (workflowRun.id === workflowRunID) {
                            process.stdout.write(".");
                        } else if (workflowRunID === -1) {
                            workflowRunID = workflowRun.id;

                            logger.info(`Workflow run ID ${workflowRunID}`);
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
    protected async publish(): Promise<void> {
        let publish: boolean;

        const repositoryState = this.repositoryState;

        // Scrap any incomplete publishing if pre-release identifier is not beta.
        if (repositoryState.preReleaseIdentifier !== "beta") {
            repositoryState.phaseState.step = undefined;
        }

        if (repositoryState.preReleaseIdentifier === "alpha") {
            if (this.anyChanges(repositoryState.repository.phaseStates.alpha?.dateTime, false)) {
                throw new Error("Repository has changed since last alpha published");
            }

            publish = true;

            this.updatePackageVersion(undefined, undefined, undefined, "beta");

            // Revert to default registry for organization.
            this.run(false, false, "npm", "config", "delete", this.atOrganizationRegistry, "--location", "project");
        } else {
            const step = repositoryState.phaseState.step;
            const startingPublication = step === undefined;

            // Step is defined and not "complete" if previous attempt failed at that step.
            publish = !startingPublication && step !== "complete";

            // Ignore changes after publication process has started.
            if (startingPublication && this.anyChanges(repositoryState.repository.phaseStates.alpha?.dateTime, false)) {
                throw new Error("Repository has changed since last alpha published");
            }
        }

        if (publish) {
            const tag = `v${repositoryState.packageConfiguration.version}`;

            if (repositoryState.phaseState.step !== undefined) {
                logger.debug(`Repository failed at step "${repositoryState.phaseState.step}" on prior run`);
            }

            const workflowsPath = ".github/workflows/";

            let hasPushWorkflow = false;
            let hasReleaseWorkflow = false;

            if (fs.existsSync(workflowsPath)) {
                logger.debug("Checking workflows");

                for (const workflowFile of fs.readdirSync(workflowsPath).filter(workflowFile => workflowFile.endsWith(".yml"))) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Workflow configuration format is known.
                    const workflowOn = (yamlParse(fs.readFileSync(path.resolve(workflowsPath, workflowFile)).toString()) as WorkflowConfiguration).on;

                    if (workflowOn.push !== undefined && (workflowOn.push?.branches === undefined || workflowOn.push.branches.includes("v*"))) {
                        logger.debug("Repository has push workflow");

                        hasPushWorkflow = true;
                    }

                    if (workflowOn.release !== undefined && (workflowOn.release?.types === undefined || workflowOn.release.types.includes("published"))) {
                        logger.debug("Repository has release workflow");

                        hasReleaseWorkflow = true;
                    }
                }
            }

            await this.runStep("update", () => {
                this.updateOrganizationDependencies();
            });

            await this.runStep("build", () => {
                this.run(false, false, "npm", "run", "build:release", "--if-present");
            });

            await this.runStep("commit", () => {
                this.commitUpdatedPackageVersion();
            });

            await this.runStep("tag", () => {
                this.run(false, false, "git", "tag", tag);
            });

            await this.runStep("push", () => {
                this.run(false, false, "git", "push", "--atomic", "origin", repositoryState.branch, tag);
            });

            if (hasPushWorkflow) {
                await this.runStep("workflow (push)", async () => {
                    await this.validateWorkflow();
                });
            }

            await this.runStep("release", async () => {
                if (this.dryRun) {
                    logger.info("Dry run: Create release");
                } else {
                    await this._octokit.rest.repos.createRelease({
                        owner: this.configuration.organization,
                        repo: repositoryState.repositoryName,
                        tag_name: tag,
                        name: `Release ${tag}`,
                        prerelease: true
                    });
                }
            });

            if (hasReleaseWorkflow) {
                await this.runStep("workflow (release)", async () => {
                    await this.validateWorkflow();
                });
            }

            this.updatePhaseState({
                dateTime: new Date(),
                tag,
                step: "complete"
            });
        }
    }

    /**
     * @inheritDoc
     */
    protected override finalizeAll(): void {
        // Publication complete; reset steps to undefined for next run.
        for (const repository of Object.values(this.configuration.repositories)) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- All beta phase states are defined by this point.
            repository.phaseStates.beta!.step = undefined;
        }
    }
}

// Detailed syntax checking not required as this is an internal tool.
await new PublishBeta(process.argv.includes("--dry-run")).publishAll().catch((e: unknown) => {
    logger.error(e);
});
