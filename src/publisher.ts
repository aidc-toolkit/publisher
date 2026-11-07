import { getLogger, i18nCoreCLILanguageDetector, i18nCoreInit, LogLevels, type Promisable } from "@aidc-toolkit/core";
import i18next from "i18next";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as process from "node:process";
import * as readlinePromises from "node:readline/promises";
import type { Logger } from "tslog";
import { Configuration } from "./configuration.js";
import type { Phase } from "./phase.js";
import type { Repository } from "./repository.js";

/**
 * Run options.
 */
export const RunOptions = {
    /**
     * Run always.
     */
    RunAlways: 0,

    /**
     * Skip if in dry run mode.
     */
    SkipOnDryRun: 1,

    /**
     * Run command with "--dry-run" parameter if in dry run mode.
     */
    ParameterizeOnDryRun: 2
} as const;

/**
 * Run option key.
 */
export type RunOptionKey = keyof typeof RunOptions;

/**
 * Run option.
 */
export type RunOption = typeof RunOptions[RunOptionKey];

/**
 * Publisher base class.
 */
export abstract class Publisher<TPhase extends Phase | undefined> {
    /**
     * Phase or undefined if not publishing.
     */
    readonly #phase: TPhase;

    /**
     * If true, output what would be produced rather than producing it.
     */
    readonly #isDryRun: boolean;

    /**
     * Logger.
     */
    readonly #logger: Logger<object>;

    /**
     * Configuration.
     */
    #configuration!: Configuration<TPhase>;

    /**
     * True if the current branch is the latest version branch.
     */
    #isLatestVersionBranch!: boolean;

    /**
     * Current repository. Final value will point to the publisher repository if needed for finalization.
     */
    #repository!: Repository<TPhase>;

    /**
     * Current branch.
     */
    #branch!: string;

    /**
     * Constructor.
     *
     * @param phase
     * Phase or undefined if not publishing.
     *
     * @param isDryRun
     * If true, output what would be produced rather than producing it.
     */
    constructor(phase: TPhase, isDryRun: boolean) {
        this.#phase = phase;
        this.#isDryRun = isDryRun;

        // Start with a default log level.
        this.#logger = getLogger(LogLevels.Info);
    }

    /**
     * Get the phase.
     */
    protected get phase(): TPhase {
        return this.#phase;
    }

    /**
     * Determine if outputs what would be produced rather than producing it.
     */
    protected get isDryRun(): boolean {
        return this.#isDryRun;
    }

    /**
     * Get the logger.
     */
    get logger(): Logger<object> {
        return this.#logger;
    }

    /**
     * Get the configuration.
     */
    protected get configuration(): Configuration<TPhase> {
        return this.#configuration;
    }

    /**
     * Get the current repository.
     */
    get repository(): Repository<TPhase> {
        return this.#repository;
    }

    /**
     * Get the current branch.
     */
    get branch(): string {
        return this.#branch;
    }

    /**
     * Run a command and optionally capture its output.
     *
     * @param runOption
     * Run option; applies only if in dry run mode.
     *
     * @param captureOutput
     * If true, output is captured and returned.
     *
     * @param allowErrorStatus
     * If true, allow error status and return output anyway.
     *
     * @param command
     * Command to run.
     *
     * @param args
     * Arguments to command.
     *
     * @returns
     * Output if captured or empty array if not.
     */
    protected run(runOption: RunOption, captureOutput: boolean, allowErrorStatus: boolean, command: string, ...args: string[]): string[] {
        // Ignore run option if not in dry run mode.
        const effectiveRunOption = !this.isDryRun ? RunOptions.RunAlways : runOption;

        if (effectiveRunOption === RunOptions.SkipOnDryRun && captureOutput) {
            throw new Error("Cannot capture output in dry run mode");
        }

        // Construct all arguments.
        const allArgs = [...args, ...this.configuration.getAdditionalArgs(command), ...effectiveRunOption !== RunOptions.ParameterizeOnDryRun ? [] : ["--dry-run"]];

        let output: string[];

        const runningCommand = `Running command "${command}" with arguments [${allArgs.join(", ")}].`;

        if (effectiveRunOption === RunOptions.SkipOnDryRun) {
            this.logger.info(`Dry run: ${runningCommand}`);

            output = [];
        } else {
            this.logger.trace(runningCommand);

            const spawnResult = spawnSync(command, allArgs, {
                stdio: ["inherit", captureOutput ? "pipe" : "inherit", "inherit"]
            });

            if (spawnResult.error !== undefined) {
                throw spawnResult.error;
            }

            if (spawnResult.status === null) {
                throw new Error(`Terminated by signal ${spawnResult.signal}`);
            }

            if (!allowErrorStatus && spawnResult.status !== 0) {
                throw new Error(`Failed with status ${spawnResult.status}`);
            }

            // Last line is also terminated by newline and split() places empty string at the end, so use slice() to remove it.
            output = captureOutput ? spawnResult.stdout.toString().split("\n").slice(0, -1) : [];

            if (captureOutput) {
                this.logger.debug(`Output:\n${output.join("\n")}`);
            }
        }

        return output;
    }

    /**
     * Ask user a question and get an answer.
     *
     * @param question
     * Question.
     *
     * @param validAnswers
     * Valid answers. If provided, first element is default answer.
     *
     * @returns
     * Answer.
     */
    protected async ask(question: string, validAnswers?: string[]): Promise<string> {
        using readlineInterface = readlinePromises.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        let answer;

        // Ask until the answer is valid.
        do {
            // eslint-disable-next-line no-await-in-loop -- Can't proceed without getting an answer.
            answer = await readlineInterface.question(question);

            if (validAnswers !== undefined && validAnswers.length !== 0) {
                if (answer === "") {
                    // Take first valid answer as default.
                    answer = validAnswers[0];
                } else if (!validAnswers.includes(answer)) {
                    answer = undefined;
                }
            }
        } while (answer === undefined);

        return answer;
    }

    /**
     * Set the alpha registry for the organization.
     */
    protected setOrganizationAlphaRegistry(): void {
        this.run(RunOptions.SkipOnDryRun, false, false, "npm", "config", "set", `${this.configuration.atOrganizationRegistryParameter}=${this.configuration.alphaRegistry}`, "--location", "project");
    }

    /**
     * Unset the alpha registry for the organization.
     */
    protected unsetOrganizationAlphaRegistry(): void {
        this.run(RunOptions.SkipOnDryRun, false, false, "npm", "config", "delete", this.configuration.atOrganizationRegistryParameter, "--location", "project");
    }

    /**
     * Get the dependency version for a dependency repository.
     *
     * @param dependencyRepository
     * Dependency repository.
     *
     * @returns
     * Dependency version.
     */
    protected abstract getDependencyVersion(dependencyRepository: Repository<TPhase>): string;

    /**
     * Handle remote changes. Called when remote changes are detected so that they may be handled before publishing.
     *
     * @returns
     * True if the phase allows for outstanding remote changes. Default is false.
     */
    protected handleRemoteChanges(): boolean {
        return false;
    }

    /**
     * Determine if branch is valid for the phase.
     *
     * @returns
     * True if branch is valid for the phase. Default is true.
     */
    protected isValidBranch(): boolean {
        return true;
    }

    /**
     * Get the next branch in the versions or main if none.
     *
     * @returns
     * Next branch or undefined if current branch is not a version branch.
     */
    protected getNextBranch(): string | undefined {
        let nextBranch;

        let nextBranchVersionIndex = this.configuration.versions.indexOf(this.branch.substring(1));

        if (nextBranchVersionIndex !== -1) {
            while (nextBranch === undefined && ++nextBranchVersionIndex < this.configuration.versions.length) {
                // Branch is version preceded by 'v'.
                const candidateNextBranch = `v${this.configuration.versions[nextBranchVersionIndex]}`;

                if (this.run(RunOptions.RunAlways, true, false, "git", "ls-remote", "--heads", "origin", candidateNextBranch).length !== 0) {
                    // Next branch exists.
                    nextBranch = candidateNextBranch;
                }
            }

            nextBranch ??= "main";
        }

        return nextBranch;
    }

    /**
     * Determine if there have been any changes to the current repository.
     *
     * @param phaseDateTime
     * Phase date/time to check against or undefined if phase never before published.
     *
     * @returns
     * True if there have been any changes since the phase date/time.
     */
    protected anyChanges(phaseDateTime: Date | undefined): boolean {
        let anyChanges: boolean;

        const excludePaths = this.repository.excludePaths;

        const changedFilesSet = new Set<string>();

        const logger = this.logger;

        /**
         * Process a changed file.
         *
         * @param status
         * "R" if the file has been renamed, "D" if the file has been deleted, otherwise file has been added.
         *
         * @param file
         * Original file name if status is "R", otherwise file to be added or deleted.
         *
         * @param newFile
         * New file name if status is "R", undefined otherwise.
         */
        function processChangedFile(status: string, file: string, newFile: string | undefined): void {
            if (!/^[ AMDR]{1,2}$/u.test(status)) {
                throw new Error(`Unknown status "${status}" for file "${file}"`);
            }

            let resolvedStatus: string;

            if (status.length === 1) {
                resolvedStatus = status;
            } else {
                const indexStatus = status.charAt(0);
                const workingTreeStatus = status.charAt(1);

                if (indexStatus === " ") {
                    resolvedStatus = workingTreeStatus;
                } else if (workingTreeStatus === " ") {
                    resolvedStatus = indexStatus;
                } else if (workingTreeStatus === "D") {
                    // Deleted from working tree takes precedence.
                    resolvedStatus = "D";
                } else if (indexStatus === "A") {
                    // Added to working tree takes precedence.
                    resolvedStatus = "A";
                } else {
                    // Only options left are modified and renamed.
                    resolvedStatus = indexStatus;
                }
            }

            // Status is "D" if deleted, "R" if renamed.
            const deleteFile = resolvedStatus === "D" || resolvedStatus === "R" ? file : undefined;
            const addFile = resolvedStatus === "R" ? newFile : resolvedStatus !== "D" ? file : undefined;

            // Remove deleted file; anything that depends on a deleted file will have been modified.
            if (deleteFile !== undefined && changedFilesSet.delete(deleteFile)) {
                logger.debug(`-${deleteFile}`);
            }

            if (addFile !== undefined && !changedFilesSet.has(addFile)) {
                // Exclude test directory and any explicitly excluded files or directories.
                if (!addFile.startsWith("test/") && excludePaths.every(excludePath => addFile !== excludePath && (!excludePath.endsWith("/") || !addFile.startsWith(excludePath)))) {
                    logger.debug(`+${addFile}`);

                    changedFilesSet.add(addFile);
                } else {
                    // File is excluded.
                    logger.debug(`*${addFile}`);
                }
            }
        }

        if (this.run(RunOptions.RunAlways, true, false, "git", "fetch", "--porcelain", "--dry-run").length !== 0 && !this.handleRemoteChanges()) {
            throw new Error("Remote repository has outstanding changes");
        }

        // Phase date/time is undefined if never before published.
        if (phaseDateTime !== undefined) {
            // Get all files committed since last published.
            for (const line of this.run(RunOptions.RunAlways, true, false, "git", "log", "--since", phaseDateTime.toISOString(), "--name-status", "--reverse", "--pretty=oneline")) {
                // Header starts with 40-character SHA.
                if (/^[0-9a-f]{40} /u.test(line)) {
                    logger.debug(`Commit SHA ${line.substring(0, 40)}`);
                } else {
                    const [status, file, newFile] = line.split("\t");

                    // Only first character is of interest.
                    processChangedFile(status.charAt(0), file, newFile);
                }
            }

            // Get all uncommitted files.
            const output = this.run(RunOptions.RunAlways, true, false, "git", "status", "--porcelain");

            if (output.length !== 0) {
                const committedCount = changedFilesSet.size;

                logger.debug("Uncommitted");

                for (const line of output) {
                    // Line is two-character status, space, and detail.
                    const status = line.substring(0, 2);
                    const [file, newFile] = line.substring(3).split(" -> ");

                    processChangedFile(status, file, newFile);
                }

                // Beta or production publication requires that repository be fully committed except for excluded paths.
                if (this.phase !== "alpha" && changedFilesSet.size !== committedCount) {
                    throw new Error("Repository has uncommitted changes");
                }
            }

            const lastPublishedDateTime = new Date(phaseDateTime);

            anyChanges = false;

            for (const changedFile of changedFilesSet) {
                // Files with spaces will have been quoted.
                const unquotedChangedFile = changedFile.replace(/^"(?<s>.*)"$/u, "$<s>");

                if (fs.lstatSync(unquotedChangedFile).mtime > lastPublishedDateTime) {
                    if (!anyChanges) {
                        logger.info("Changes");

                        anyChanges = true;
                    }

                    logger.info(`>${unquotedChangedFile}`);
                }
            }

            if (!anyChanges) {
                logger.info("No changes");
            }
        } else {
            logger.info("Never published");

            // No last published, so there must have been changes.
            anyChanges = true;
        }

        return anyChanges;
    }

    /**
     * Commit files that have been modified.
     *
     * @param message
     * Commit message.
     *
     * @param files
     * Files to commit; if none, defaults to "--all".
     */
    protected commitModified(message: string, ...files: string[]): void {
        const modifiedFiles: string[] = [];

        if (files.length === 0) {
            this.logger.debug(`Committing all modified files with message "${message}`);

            modifiedFiles.push("--all");
        } else {
            for (const line of this.run(RunOptions.RunAlways, true, false, "git", "status", ...files, "--porcelain")) {
                const status = line.substring(0, 2);
                const modifiedFile = line.substring(3);

                // Only interest is in local additions and modifications with no conflicts.
                if (status !== "A " && status !== " M" && status !== "AM" && status !== "M ") {
                    throw new Error(`Unsupported status "${status}" for ${modifiedFile}`);
                }

                modifiedFiles.push(modifiedFile);
            }

            if (modifiedFiles.length !== 0) {
                this.logger.debug(`Committing modified files ${modifiedFiles} with message "${message}`);
            } else {
                this.logger.debug("No modified files to commit");
            }
        }

        if (modifiedFiles.length !== 0) {
            this.run(RunOptions.SkipOnDryRun, false, false, "git", "commit", ...modifiedFiles, "--message", message);
        }
    }

    /**
     * Update package lock configuration.
     */
    protected updatePackageLockConfiguration(): void {
        // Run "npm install" to update package configuration lock file.
        this.run(RunOptions.ParameterizeOnDryRun, false, false, "npm", "install");
    }

    /**
     * Get the current branch.
     *
     * @returns
     * Current branch.
     */
    #getCurrentBranch(): string {
        return this.run(RunOptions.RunAlways, true, false, "git", "branch", "--show-current")[0];
    }

    /**
     * Initialize publication.
     */
    protected async initialize(): Promise<void> {
        this.logger.trace("Initializing...");

        this.#configuration = await Configuration.load<TPhase>(this.phase, this.logger, this.isDryRun);

        // Publisher is valid only when on latest version branch.
        this.#isLatestVersionBranch = this.#getCurrentBranch() === `v${this.configuration.latestVersion}`;
    }

    /**
     * Publish current repository.
     */
    protected abstract publish(): Promisable<void>;

    /**
     * Publish all repositories.
     */
    async publishAll(): Promise<void> {
        const logger = this.logger;

        try {
            await i18nCoreInit(i18next.use(i18nCoreCLILanguageDetector)).then(async () => this.initialize());

            const configuration = this.configuration;
            const publishState = configuration.publishState;

            if (publishState.repositoryName !== undefined) {
                logger.trace(`Resuming at ${publishState.repositoryName} repository`);
            }

            const getDependencyVersion = this.getDependencyVersion.bind(this);

            const startDirectory = process.cwd();

            logger.debug(`Start directory is ${startDirectory}`);

            for (const [repositoryName, repository] of Object.entries(configuration.repositories)) {
                if (publishState.repositoryName === undefined || publishState.repositoryName === repositoryName) {
                    this.#repository = repository;

                    publishState.repositoryName = repositoryName;

                    // All repository directories are expected to be children of the parent of this repository.
                    const directory = `../${repository.directory}`;

                    if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
                        logger.info(`Repository ${repositoryName}...`);

                        try {
                            process.chdir(directory);

                            repository.startPublish();

                            logger.trace(`Working version from package.json is ${repository.workingVersion}`);

                            const branch = this.#getCurrentBranch();

                            logger.trace(`Branch is ${branch}`);

                            this.#branch = branch;

                            if (!this.isValidBranch()) {
                                throw new Error(`Branch ${branch} is not valid for ${this.phase} phase`);
                            }

                            repository.alignWithBranch(branch);

                            logger.trace(`Working version from branch is ${repository.workingVersion}`);

                            const updateDependencyPackageNamesSet = this.repository.updateOrganizationDependencies(getDependencyVersion);

                            if (updateDependencyPackageNamesSet.size !== 0) {
                                // Run "npm update" to force update of repository packages whose configured version didn't change.
                                this.run(RunOptions.ParameterizeOnDryRun, false, false, "npm", "update", ...updateDependencyPackageNamesSet);
                            }

                            // Publish the repository if on the latest version branch, no changes to code or version control are expected, or repository is the publisher repository.
                            if (this.#isLatestVersionBranch || this.phase === undefined || repositoryName === "publisher") {
                                // eslint-disable-next-line no-await-in-loop -- Next iteration requires previous to finish.
                                await this.publish();
                            } else {
                                logger.trace("Skipped");
                            }

                            delete publishState.repositoryName;
                            delete publishState.step;
                        } finally {
                            // Return to the start directory.
                            process.chdir(startDirectory);

                            // eslint-disable-next-line no-await-in-loop -- Next iteration requires previous to finish.
                            await configuration.save(false);
                        }
                    // Non-external repositories may be private and not accessible to all developers.
                    } else if (repository.dependencyType !== "external") {
                        logger.trace(`Skipping ${repository.dependencyType} repository ${repositoryName}`);
                    } else {
                        throw new Error(`Repository ${repositoryName} not found`);
                    }
                }
            }

            await this.finalize();
        } catch (e) {
            logger.error("Publish all failed", e);
        }
    }

    /**
     * Finalize publication.
     */
    protected async finalize(): Promise<void> {
        await this.configuration.save(true);

        // Publisher needs to be able to publish itself so this is not an error until the end.
        if (!this.#isLatestVersionBranch) {
            this.logger.error("Publisher is not on latest version branch. Review config/publisher.local.json before switching.");
        }
    }
}
