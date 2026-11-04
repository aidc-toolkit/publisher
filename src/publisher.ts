import {
    getLogger,
    i18nCoreInit,
    I18nLanguageDetectors,
    LogLevels,
    parseVersion,
    type Promisable
} from "@aidc-toolkit/core";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as process from "node:process";
import readline from "node:readline";
import type { Logger } from "tslog";
import { Configuration } from "./configuration.js";
import type { Phase, PhaseState } from "./phase.js";
import { Repository, RepositoryPublishState } from "./repository.js";

/**
 * Current publish state, derived from package configuration and updated during publishing.
 */
export interface CurrentPublishState<TPhase extends Phase | undefined> {
    /**
     * Repository from configuration.
     */
    readonly repository: Repository<TPhase>;

    /**
     * Branch.
     */
    readonly branch: string;

    /**
     * True if save package configuration is pending.
     */
    savePackageConfigurationPending: boolean;

    /**
     * True if any dependencies, including additional, have been updated.
     */
    anyDependenciesUpdated: boolean;
}

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
     * Current publish state. Final value will point to the publisher repository if needed for finalization.
     */
    #currentPublishState?: CurrentPublishState<TPhase>;

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
     * Get the package name for a repository name.
     *
     * @param repositoryName
     * Repository name.
     *
     * @returns
     * Package name.
     */
    protected getPackageName(repositoryName: string): string {
        return `${this.configuration.atOrganization}/${repositoryName}`;
    }

    /**
     * Get the current publish state.
     */
    protected get currentPublishState(): CurrentPublishState<TPhase> {
        // Repository state should be accessed only during active publication.
        if (this.#currentPublishState === undefined) {
            throw new Error("Repository publish state undefined");
        }

        return this.#currentPublishState;
    }

    /**
     * Get the repository publish state for a repository; create it if undefined.
     *
     * @param repositoryName
     * Repository name.
     *
     * @returns
     * Repository publish state.
     */
    protected getRepositoryPublishState(repositoryName = this.currentPublishState.repository.name): RepositoryPublishState {
        return this.configuration.repositories[repositoryName].repositoryPublishState;
    }

    /**
     * Get the phase state for a repository.
     *
     * @param repositoryName
     * Repository name.
     *
     * @returns
     * Phase state.
     */
    protected getPhaseState(repositoryName = this.currentPublishState.repository.name): PhaseState {
        return this.configuration.repositories[repositoryName].getPhaseState(true);
    }

    /**
     * Get the phase date/time for a repository.
     *
     * @param repositoryName
     * Repository name. If undefined, the return value may be undefined.
     *
     * @returns
     * Phase date/time or undefined if phase never before published.
     */
    protected getPhaseDateTime<TRepositoryName extends string | undefined>(repositoryName?: TRepositoryName): TRepositoryName extends string ? Date : Date | undefined {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Type is determined by repository name.
        return this.configuration.repositories[repositoryName ?? this.currentPublishState.repository.name].getPhaseDateTime(repositoryName !== undefined) as TRepositoryName extends string ? Date : Date | undefined;
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
     * @param dependencyRepositoryName
     * Dependency repository name.
     *
     * @returns
     * Dependency version.
     */
    protected abstract dependencyVersionFor(dependencyRepositoryName: string): string;

    /**
     * Determine if repository change is valid for the phase.
     *
     * @returns
     * True if repository change is valid for the phase.
     */
    protected abstract isValidRepositoryChange(): boolean;

    /**
     * Determine if branch is valid for the phase.
     *
     * @returns
     * True if branch is valid for the phase.
     */
    protected abstract isValidBranch(): boolean;

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
            this.logger.debug(runningCommand);

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
                this.logger.trace(`Output:\n${output.join("\n")}`);
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
        using readlineInterface = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        /**
         * Ask the question until the answer is valid.
         *
         * @returns
         * Answer.
         */
        async function askUntilValid(): Promise<string> {
            // eslint-disable-next-line promise/avoid-new -- Method doesn't meet promisify callback requirements.
            return new Promise((resolve) => {
                readlineInterface.question(question, (providedAnswer) => {
                    let answer;

                    if (validAnswers !== undefined && validAnswers.length !== 0) {
                        if (providedAnswer === "") {
                            answer = validAnswers[0];
                        } else if (validAnswers.includes(providedAnswer)) {
                            answer = providedAnswer;
                        }
                    } else {
                        answer = providedAnswer;
                    }

                    resolve(answer ?? askUntilValid());
                });
            });
        }

        return await askUntilValid();
    }

    /**
     * Get the next branch in the versions or main if none.
     *
     * @returns
     * Next branch or undefined if current branch is not a version branch.
     */
    protected getNextBranch(): string | undefined {
        let nextBranch;

        let nextBranchVersionIndex = this.configuration.versions.indexOf(this.currentPublishState.branch.substring(1));

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
     * Get the repository name for a dependency if it belongs to the organization or null if not.
     *
     * @param dependency
     * Dependency.
     *
     * @returns
     * Repository name for dependency or null.
     */
    protected dependencyRepositoryName(dependency: string): string | null {
        const parsedDependency = dependency.split("/");

        return parsedDependency.length === 2 && parsedDependency[0] === this.configuration.atOrganization ? parsedDependency[1] : null;
    }

    /**
     * Determine if an organization dependency has been updated.
     *
     * @param phaseDateTime
     * Phase date/time of the current repository.
     *
     * @param dependencyRepositoryName
     * Dependency repository name.
     *
     * @returns
     * True if organization dependency has been updated.
     */
    #isOrganizationDependencyUpdated(phaseDateTime: Date | undefined, dependencyRepositoryName: string): boolean {
        const isUpdated = phaseDateTime === undefined || phaseDateTime.getTime() < this.getPhaseDateTime(dependencyRepositoryName).getTime();

        if (isUpdated) {
            this.logger.trace(`Dependency repository ${dependencyRepositoryName} updated`);
        }

        return isUpdated;
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

        const excludePaths = this.currentPublishState.repository.excludePaths;

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

        if (this.run(RunOptions.RunAlways, true, false, "git", "fetch", "--porcelain", "--dry-run").length !== 0 && !this.isValidRepositoryChange()) {
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
        }

        if (modifiedFiles.length !== 0) {
            this.run(RunOptions.ParameterizeOnDryRun, false, false, "git", "commit", ...modifiedFiles, "--message", message);
        }
    }

    /**
     * Save package configuration.
     */
    protected savePackageConfiguration(): void {
        const repositoryPublishState = this.currentPublishState;

        repositoryPublishState.repository.savePackageConfiguration();

        repositoryPublishState.savePackageConfigurationPending = false;
    }

    /**
     * Update package lock configuration.
     */
    protected updatePackageLockConfiguration(): void {
        // Run "npm install" to update package configuration lock file.
        this.run(RunOptions.ParameterizeOnDryRun, false, false, "npm", "install");
    }

    /**
     * Commit changes resulting from updating the package version.
     *
     * @param files
     * Files to commit; if none, defaults to "--all".
     */
    protected commitUpdatedPackageVersion(...files: string[]): void {
        this.commitModified(`Updated to version ${this.currentPublishState.repository.packageConfiguration.version}.`, ...files);
    }

    /**
     * Save the configuration.
     *
     * @param isComplete
     * If true, publication is complete.
     */
    async #saveConfiguration(isComplete: boolean): Promise<void> {
        await this.configuration.save(isComplete);
    }
    
    /**
     * Build the publish state for the current repository.
     *
     * @param repository
     * Current repository.
     */
    #buildCurrentPublishState(repository: Repository<TPhase>): void {
        const branch = this.run(RunOptions.RunAlways, true, false, "git", "branch", "--show-current")[0];

        this.#currentPublishState = {
            repository,
            branch,
            savePackageConfigurationPending: false,
            anyDependenciesUpdated: false
        };

        const repositoryPublishState = this.#currentPublishState;

        repository.startPublish();

        if (!this.isValidBranch()) {
            throw new Error(`Branch ${branch} is not valid for ${this.phase} phase`);
        }

        const parsedBranchGroups = /^v(?<branchMajorVersion>\d+)\.(?<branchMinorVersion>\d+)/u.exec(branch)?.groups;

        // If this is a version branch, update the package version if required.
        if (parsedBranchGroups !== undefined) {
            const branchMajorVersion = Number(parsedBranchGroups["branchMajorVersion"]);
            const branchMinorVersion = Number(parsedBranchGroups["branchMinorVersion"]);
            
            const parsedVersion = repository.parsedVersion;

            // If version doesn't match, branch is new.
            if (parsedVersion.majorVersion !== branchMajorVersion || parsedVersion.minorVersion !== branchMinorVersion) {
                if (this.phase !== "alpha") {
                    throw new Error("Version transition not permitted except in alpha phase");
                }

                if (parsedVersion.majorVersion !== branchMajorVersion ? parsedVersion.majorVersion !== branchMajorVersion - 1 || branchMinorVersion !== 0 : parsedVersion.minorVersion !== branchMinorVersion - 1) {
                    throw new Error(`Invalid transition from ${parsedVersion.majorVersion}.${parsedVersion.minorVersion} to ${branchMajorVersion}.${branchMinorVersion}`);
                }

                // Update package version with pre-release identifier "pending"; alpha publisher will commit it.
                repository.updatePackageVersion(branchMajorVersion, branchMinorVersion, 0, "pending");
            }
        }

        if (this.phase !== undefined) {
            const packageConfiguration = repository.packageConfiguration;
            const parsedVersion = repository.parsedVersion;
            const phaseDateTime = this.getPhaseDateTime();

            const dependencyPackageNames = this.getRepositoryPublishState().dependencyPackageNames;

            const updateDependencyPackageNamesSet = new Set<string>();

            for (const dependencies of [packageConfiguration.devDependencies ?? {}, packageConfiguration.dependencies ?? {}]) {
                for (const dependencyPackageName of Object.keys(dependencies)) {
                    const dependencyRepositoryName = this.dependencyRepositoryName(dependencyPackageName);

                    // Dependency repository name is null if dependency is not within the organization.
                    if (dependencyRepositoryName !== null) {
                        this.logger.trace(`Organization dependency ${dependencyPackageName} from package configuration`);

                        dependencyPackageNames.push(dependencyPackageName);

                        const dependencyPhaseState = this.getPhaseState(dependencyRepositoryName);
                        const dependencyVersion = dependencyPhaseState.version;
                        const dependencyParsedVersion = parseVersion(dependencyVersion);

                        // Dependency is valid if it has a lower major version.
                        let validVersionSequence = dependencyParsedVersion.majorVersion < parsedVersion.majorVersion;

                        if (!validVersionSequence && dependencyParsedVersion.majorVersion === parsedVersion.majorVersion) {
                            // Dependency is valid if it has a lower minor version.
                            validVersionSequence = dependencyParsedVersion.minorVersion < parsedVersion.minorVersion;

                            if (!validVersionSequence && dependencyParsedVersion.minorVersion === parsedVersion.minorVersion) {
                                // Dependency is valid if it has a lower or equal patch version or if this repository is about to update its patch version to match.
                                validVersionSequence = dependencyParsedVersion.patchVersion <= parsedVersion.patchVersion ||
                                    (dependencyParsedVersion.patchVersion === parsedVersion.patchVersion + 1 && this.phase === "alpha" && dependencyParsedVersion.preReleaseIdentifier === "alpha" && parsedVersion.preReleaseIdentifier !== "alpha");
                            }
                        }

                        if (!validVersionSequence) {
                            throw new Error(`Repository version ${packageConfiguration.version} is less than ${dependencyRepositoryName} dependency version ${dependencyVersion}`);
                        }

                        if (this.#isOrganizationDependencyUpdated(phaseDateTime, dependencyRepositoryName)) {
                            const dependencyRepositoryVersion = this.dependencyVersionFor(dependencyRepositoryName);

                            if (dependencies[dependencyPackageName] !== dependencyRepositoryVersion) {
                                // Dependency will be updated alongside all other dependencies.
                                dependencies[dependencyPackageName] = dependencyRepositoryVersion;
                            } else {
                                updateDependencyPackageNamesSet.add(dependencyPackageName);

                                const dependencyRepositoryPublishState = this.configuration.publishState.repositoryPublishStates[dependencyRepositoryName];

                                for (const dependencyDependencyPackageName of dependencyRepositoryPublishState.dependencyPackageNames) {
                                    updateDependencyPackageNamesSet.add(dependencyDependencyPackageName);
                                }
                            }

                            repositoryPublishState.anyDependenciesUpdated = true;
                        }
                    }
                }
            }

            if (updateDependencyPackageNamesSet.size !== 0) {
                // Run "npm update" to force update of repository packages whose configured version didn't change.
                this.run(RunOptions.ParameterizeOnDryRun, false, false, "npm", "update", ...updateDependencyPackageNamesSet);
            }

            // Saving the package configuration would affect check for any changes so defer it.
            repositoryPublishState.savePackageConfigurationPending = repositoryPublishState.anyDependenciesUpdated;

            for (const additionalDependencyRepositoryName of repository.additionalDependencies) {
                this.logger.trace(`Organization dependency ${this.getPackageName(additionalDependencyRepositoryName)} from additional dependencies`);

                if (this.#isOrganizationDependencyUpdated(phaseDateTime, additionalDependencyRepositoryName)) {
                    repositoryPublishState.anyDependenciesUpdated = true;
                }
            }
        }
    }

    /**
     * Initialize publication.
     */
    protected async initialize(): Promise<void> {
        this.#configuration = await Configuration.load<TPhase>(this.phase, this.logger, this.isDryRun);
    }

    /**
     * Publish current repository.
     */
    protected abstract publish(): Promisable<void>;

    /**
     * Publish all repositories.
     */
    async publishAll(): Promise<void> {
        try {
            await i18nCoreInit(I18nLanguageDetectors.CLI, false).then(async () => this.initialize());

            const startDirectory = process.cwd();

            for (const [repositoryName, repository] of Object.entries(this.configuration.repositories)) {
                const publishState = this.configuration.publishState;

                if (publishState.repositoryName === undefined || publishState.repositoryName === repositoryName) {
                    publishState.repositoryName = repositoryName;

                    // All repository directories are expected to be children of the parent of this repository.
                    const directory = `../${repository.directory}`;

                    if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
                        this.logger.info(`Repository ${repositoryName}...`);

                        try {
                            process.chdir(directory);

                            this.#buildCurrentPublishState(repository);

                            // eslint-disable-next-line no-await-in-loop -- Next iteration requires previous to finish.
                            await this.publish();

                            delete publishState.repositoryName;
                            delete publishState.step;
                        } finally {
                            // Return to the start directory.
                            process.chdir(startDirectory);

                            // eslint-disable-next-line no-await-in-loop -- Next iteration requires previous to finish.
                            await this.#saveConfiguration(false);
                        }
                    // Non-external repositories may be private and not accessible to all developers.
                    } else if (repository.dependencyType === "external") {
                        throw new Error(`Repository ${repositoryName} not found`);
                    }
                }
            }

            await this.finalize();
        } catch (e) {
            this.logger.error("Publish all failed", e);
        }
    }

    /**
     * Finalize publication.
     */
    protected async finalize(): Promise<void> {
        await this.#saveConfiguration(true);
    }
}
