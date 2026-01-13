import { getLogger, i18nCoreInit, I18nEnvironments, pick, type Promisable } from "@aidc-toolkit/core";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as process from "node:process";
import type { Logger } from "tslog";
import {
    type Configuration,
    loadConfiguration,
    type Phase,
    type PhaseState,
    type PublishState,
    type Repository,
    saveConfiguration,
    SHARED_CONFIGURATION_PATH
} from "./configuration.js";

export const PACKAGE_CONFIGURATION_PATH = "package.json";

export const PACKAGE_LOCK_CONFIGURATION_PATH = "package-lock.json";

/**
 * Configuration layout of package.json (relevant attributes only).
 */
export interface PackageConfiguration {
    /**
     * Name.
     */
    readonly name: string;

    /**
     * Version.
     */
    version: string;

    /**
     * Development dependencies.
     */
    readonly devDependencies?: Record<string, string>;

    /**
     * Dependencies.
     */
    readonly dependencies?: Record<string, string>;
}

/**
 * Publish state of current repository, derived from package configuration and updated during publishing.
 */
export interface RepositoryPublishState {
    /**
     * Repository name from configuration.
     */
    readonly repositoryName: string;

    /**
     * Repository from configuration.
     */
    readonly repository: Repository;

    /**
     * Phase state.
     */
    phaseState: PhaseState;

    /**
     * Phase date/time or undefined if phase never before published. May differ from date/time within `phaseState`
     * itself.
     */
    phaseDateTime: Date | undefined;

    /**
     * Branch.
     */
    readonly branch: string;

    /**
     * Package configuration.
     */
    readonly packageConfiguration: PackageConfiguration;

    /**
     * Major version.
     */
    majorVersion: number;

    /**
     * Minor version.
     */
    minorVersion: number;

    /**
     * Patch version.
     */
    patchVersion: number;

    /**
     * Pre-release identifier or null if none.
     */
    preReleaseIdentifier: string | null;

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
export abstract class Publisher {
    /**
     * Phase.
     */
    readonly #phase: Phase;

    /**
     * If true, outputs what would be run rather than running it.
     */
    readonly #dryRun: boolean;

    /**
     * Configuration. Merger of shared and local configurations.
     */
    readonly #configuration: Configuration;

    /**
     * Latest version.
     */
    readonly #latestVersion: string;

    /**
     * Publish state, same as in configuration but always defined during publication.
     */
    readonly #publishState: PublishState;

    /**
     * Logger.
     */
    readonly #logger: Logger<object>;

    /**
     * At organization.
     */
    readonly #atOrganization: string;

    /**
     * At organization registry parameter.
     */
    readonly #atOrganizationRegistry: string;

    /**
     * Publish state for current repository.
     */
    #repositoryPublishState: RepositoryPublishState | undefined;

    /**
     * Constructor.
     *
     * @param phase
     * Phase.
     *
     * @param dryRun
     * If true, outputs what would be run rather than running it.
     */
    protected constructor(phase: Phase, dryRun: boolean) {
        this.#phase = phase;
        this.#dryRun = dryRun;

        this.#configuration = loadConfiguration();
        this.#latestVersion = this.#configuration.versions[this.configuration.versions.length - 1];

        if (this.#configuration.publishState === undefined) {
            this.#publishState = {
                phase
            };

            this.#configuration.publishState = this.#publishState;
        } else {
            this.#publishState = this.#configuration.publishState;
            
            if (this.#publishState.phase !== phase) {
                throw new Error(`Attempting to publish ${phase} phase despite incomplete ${this.#publishState.phase} phase`);
            }
        }

        this.#logger = getLogger(this.configuration.logLevel);

        this.#atOrganization = `@${this.configuration.organization}`;

        this.#atOrganizationRegistry = `${this.atOrganization}:registry${phase === "alpha" ? `=${this.configuration.alphaRegistry}` : ""}`;

        this.#repositoryPublishState = undefined;
    }

    /**
     * Get the phase.
     */
    protected get phase(): Phase {
        return this.#phase;
    }

    /**
     * Determine if outputs what would be run rather than running it.
     */
    protected get dryRun(): boolean {
        return this.#dryRun;
    }

    /**
     * Get the configuration.
     */
    protected get configuration(): Configuration {
        return this.#configuration;
    }

    /**
     * Get the latest version.
     */
    get latestVersion(): string {
        return this.#latestVersion;
    }

    /**
     * Get the publish state.
     */
    get publishState(): PublishState {
        return this.#publishState;
    }

    /**
     * Get the logger.
     */
    get logger(): Logger<object> {
        return this.#logger;
    }

    /**
     * Get the at organization.
     */
    protected get atOrganization(): string {
        return this.#atOrganization;
    }

    /**
     * Get the at organization registry parameter.
     */
    protected get atOrganizationRegistry(): string {
        return this.#atOrganizationRegistry;
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
        return `${this.atOrganization}/${repositoryName}`;
    }

    /**
     * Get the publish state for current repository.
     */
    protected get repositoryPublishState(): RepositoryPublishState {
        // Repository state should be accessed only during active publication.
        if (this.#repositoryPublishState === undefined) {
            throw new Error("Repository publish state not defined");
        }

        return this.#repositoryPublishState;
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
     * Determine the latest date/time or undefined if all undefined.
     *
     * @param initialDateTime
     * Initial date/time.
     *
     * @param additionalDateTimes
     * Additional date/times.
     *
     * @returns
     * Latest date/time.
     */
    protected latestDateTime(initialDateTime: Date | undefined, ...additionalDateTimes: Array<Date | undefined>): Date;

    /**
     * Determine the latest date/time or undefined if all undefined.
     *
     * @param initialDateTime
     * Initial date/time.
     *
     * @param additionalDateTimes
     * Additional date/times.
     *
     * @returns
     * Latest date/time.
     */
    protected latestDateTime(initialDateTime: Date | undefined, ...additionalDateTimes: Array<Date | undefined>): Date | undefined {
        let latestDateTime = initialDateTime;

        for (const dateTime of additionalDateTimes) {
            if (dateTime !== undefined && (latestDateTime === undefined || latestDateTime.getTime() < dateTime.getTime())) {
                latestDateTime = dateTime;
            }
        }

        return latestDateTime;
    }

    /**
     * Get the phase date/time for a repository.
     *
     * @param repository
     * Repository.
     *
     * @param phaseDateTime
     * Initial phase date/time.
     *
     * @returns
     * Phase date/time or undefined if phase never before published.
     */
    protected abstract getPhaseDateTime(repository: Repository, phaseDateTime: Date | undefined): Date | undefined;

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
     * @param command
     * Command to run.
     *
     * @param args
     * Arguments to command.
     *
     * @returns
     * Output if captured or empty array if not.
     */
    protected run(runOption: RunOption, captureOutput: boolean, command: string, ...args: string[]): string[] {
        // Ignore run option if not in dry run mode.
        const effectiveRunOption = !this.dryRun ? RunOptions.RunAlways : runOption;

        if (effectiveRunOption === RunOptions.SkipOnDryRun && captureOutput) {
            throw new Error("Cannot capture output in dry run mode");
        }

        let output: string[];

        const runningCommand = `Running command "${command}" with arguments [${args.join(", ")}].`;

        if (effectiveRunOption === RunOptions.SkipOnDryRun) {
            this.logger.info(`Dry run: ${runningCommand}`);

            output = [];
        } else {
            this.logger.debug(runningCommand);

            const spawnResult = spawnSync(command, effectiveRunOption !== RunOptions.ParameterizeOnDryRun ? args : [...args, "--dry-run"], {
                stdio: ["inherit", captureOutput ? "pipe" : "inherit", "inherit"]
            });

            if (spawnResult.error !== undefined) {
                throw spawnResult.error;
            }

            if (spawnResult.status === null) {
                throw new Error(`Terminated by signal ${spawnResult.signal}`);
            }

            if (spawnResult.status !== 0) {
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

        return parsedDependency.length === 2 && parsedDependency[0] === this.atOrganization ? parsedDependency[1] : null;
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
     * @param isAdditional
     * True if this is an additional dependency.
     *
     * @returns
     * True if organization dependency has been updated.
     */
    #isOrganizationDependencyUpdated(phaseDateTime: Date | undefined, dependencyRepositoryName: string, isAdditional: boolean): boolean {
        const dependencyString = !isAdditional ? "Dependency" : "Additional dependency";

        const dependencyRepository = this.configuration.repositories[dependencyRepositoryName];
        const dependencyPhaseState = dependencyRepository.phaseStates[this.phase];

        if (dependencyPhaseState === undefined) {
            throw new Error(`*** Internal error *** ${dependencyString} ${dependencyRepositoryName} does not have state for ${this.phase} phase`);
        }

        const repositoryPhaseDateTime = this.getPhaseDateTime(dependencyRepository, dependencyPhaseState.dateTime);

        if (repositoryPhaseDateTime === undefined) {
            throw new Error(`*** Internal error *** ${dependencyString} ${dependencyRepositoryName} does not have phase date/time for ${this.phase} phase`);
        }

        const isUpdated = phaseDateTime === undefined || phaseDateTime.getTime() < repositoryPhaseDateTime.getTime();

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
     * @param ignoreGitHub
     * If true, ignore .github directory.
     *
     * @returns
     * True if there have been any changes since the phase date/time.
     */
    protected anyChanges(phaseDateTime: Date | undefined, ignoreGitHub: boolean): boolean {
        let anyChanges: boolean;

        const excludePaths = this.repositoryPublishState.repository.excludePaths ?? [];

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
                throw new Error(`Unknown status "${status} for file ${file}"`);
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
                // Exclude hidden files and directories except possibly .github directory, package-lock.json, test directory, and any explicitly excluded files or directories.
                if (((!addFile.startsWith(".") && !addFile.includes("/.")) || (!ignoreGitHub && addFile.startsWith(".github/"))) && addFile !== PACKAGE_LOCK_CONFIGURATION_PATH && !addFile.startsWith("test/") && excludePaths.filter(excludePath => addFile === excludePath || (excludePath.endsWith("/") && addFile.startsWith(excludePath))).length === 0) {
                    logger.debug(`+${addFile}`);

                    changedFilesSet.add(addFile);
                } else {
                    // File is excluded.
                    logger.debug(`*${addFile}`);
                }
            }
        }

        if (this.phase !== "alpha" && this.run(RunOptions.RunAlways, true, "git", "fetch", "--porcelain", "--dry-run").length !== 0) {
            throw new Error("Remote repository has outstanding changes");
        }

        // Phase date/time is undefined if never before published.
        if (phaseDateTime !== undefined) {
            // Get all files committed since last published.
            for (const line of this.run(RunOptions.RunAlways, true, "git", "log", "--since", phaseDateTime.toISOString(), "--name-status", "--reverse", "--pretty=oneline")) {
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
            const output = this.run(RunOptions.RunAlways, true, "git", "status", "--porcelain");

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
                if (fs.lstatSync(changedFile).mtime > lastPublishedDateTime) {
                    if (!anyChanges) {
                        logger.info("Changes");

                        anyChanges = true;
                    }

                    logger.info(`>${changedFile}`);
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
            for (const line of this.run(RunOptions.RunAlways, true, "git", "status", ...files, "--porcelain")) {
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
            this.run(RunOptions.ParameterizeOnDryRun, false, "git", "commit", ...modifiedFiles, "--message", message);
        }
    }

    /**
     * Save package configuration.
     */
    protected savePackageConfiguration(): void {
        const repositoryPublishState = this.repositoryPublishState;
        const packageConfiguration = repositoryPublishState.packageConfiguration;

        if (this.dryRun) {
            this.logger.info(`Dry run: Saving package configuration\n${JSON.stringify(pick(packageConfiguration, "name", "version", "devDependencies", "dependencies"), null, 2)}\n`);
        } else {
            fs.writeFileSync(PACKAGE_CONFIGURATION_PATH, `${JSON.stringify(packageConfiguration, null, 2)}\n`);
        }

        repositoryPublishState.savePackageConfigurationPending = false;
    }

    /**
     * Update package lock configuration.
     */
    protected updatePackageLockConfiguration(): void {
        // Run "npm install" to update package configuration lock file.
        this.run(RunOptions.ParameterizeOnDryRun, false, "npm", "install");
    }

    /**
     * Update the package version.
     *
     * @param majorVersion
     * Major version or undefined if no change.
     *
     * @param minorVersion
     * Minor version or undefined if no change.
     *
     * @param patchVersion
     * Patch version or undefined if no change.
     *
     * @param preReleaseIdentifier
     * Pre-release identifier or undefined if no change.
     *
     * @returns
     * Updated package version.
     */
    protected updatePackageVersion(majorVersion: number | undefined, minorVersion: number | undefined, patchVersion: number | undefined, preReleaseIdentifier: string | null | undefined): string {
        const repositoryPublishState = this.repositoryPublishState;

        if (majorVersion !== undefined) {
            repositoryPublishState.majorVersion = majorVersion;
        }

        if (minorVersion !== undefined) {
            repositoryPublishState.minorVersion = minorVersion;
        }

        if (patchVersion !== undefined) {
            repositoryPublishState.patchVersion = patchVersion;
        }

        if (preReleaseIdentifier !== undefined) {
            repositoryPublishState.preReleaseIdentifier = preReleaseIdentifier;
        }

        const version = `${repositoryPublishState.majorVersion}.${repositoryPublishState.minorVersion}.${repositoryPublishState.patchVersion}${repositoryPublishState.preReleaseIdentifier !== null ? `-${repositoryPublishState.preReleaseIdentifier}` : ""}`;

        repositoryPublishState.packageConfiguration.version = version;

        this.savePackageConfiguration();

        return version;
    }

    /**
     * Commit changes resulting from updating the package version.
     *
     * @param files
     * Files to commit; if none, defaults to "--all".
     */
    protected commitUpdatedPackageVersion(...files: string[]): void {
        this.commitModified(`Updated to version ${this.repositoryPublishState.packageConfiguration.version}.`, ...files);
    }

    /**
     * Update the phase state. This will replace the phase state object in the repository and the repository publish
     * state and may update the phase date/time in the repository publish state.
     *
     * @param phaseState
     * Partial phases state. Only those properties provided will be updated.
     */
    protected updatePhaseState(phaseState: Partial<PhaseState>): void {
        const repositoryPublishState = this.repositoryPublishState;

        const phaseStateDateTime = phaseState.dateTime !== undefined ?
            {
                // Git resolution is one second so round up to next second to ensure that comparisons work as expected.
                dateTime: new Date(phaseState.dateTime.getTime() - phaseState.dateTime.getMilliseconds() + 1000)
            } :
            {};

        const updatedPhaseState = {
            ...repositoryPublishState.phaseState,
            ...phaseState,
            ...phaseStateDateTime
        };

        repositoryPublishState.repository.phaseStates[this.phase] = updatedPhaseState;
        repositoryPublishState.phaseState = updatedPhaseState;

        // Setting the phase date/time overrides the logic of its initial determination.
        if (phaseStateDateTime.dateTime !== undefined) {
            repositoryPublishState.phaseDateTime = phaseStateDateTime.dateTime;
        }
    }

    /**
     * Save the configuration.
     */
    #saveConfiguration(): void {
        saveConfiguration(this.configuration, this.logger, this.dryRun);
    }

    /**
     * Build the publish state for the current repository.
     *
     * @param repositoryName
     * Current repository name.
     *
     * @param repository
     * Current repository.
     */
    #buildPublishState(repositoryName: string, repository: Repository): void {
        let phaseState = repository.phaseStates[this.phase];

        // Create phase state if necessary.
        if (phaseState === undefined) {
            phaseState = {};

            // eslint-disable-next-line no-param-reassign -- Repository is necessarily updated as part of building publish state.
            repository.phaseStates[this.phase] = phaseState;
        }

        const phaseDateTime = this.getPhaseDateTime(repository, phaseState.dateTime);

        const branch = this.run(RunOptions.RunAlways, true, "git", "branch", "--show-current")[0];

        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Package configuration format is known.
        const packageConfiguration = JSON.parse(fs.readFileSync(PACKAGE_CONFIGURATION_PATH).toString()) as PackageConfiguration;

        const version = packageConfiguration.version;

        const parsedVersionGroups = /^(?<majorVersion>\d+)\.(?<minorVersion>\d+)\.(?<patchVersion>\d+)(?:-(?<preReleaseIdentifier>alpha|beta))?$/u.exec(version)?.groups;

        if (parsedVersionGroups === undefined) {
            throw new Error(`Invalid package version ${version}`);
        }

        const majorVersion = Number(parsedVersionGroups["majorVersion"]);
        const minorVersion = Number(parsedVersionGroups["minorVersion"]);
        const patchVersion = Number(parsedVersionGroups["patchVersion"]);
        const preReleaseIdentifier = parsedVersionGroups["preReleaseIdentifier"] ?? null;

        this.#repositoryPublishState = {
            repositoryName,
            repository,
            phaseState,
            phaseDateTime,
            branch,
            packageConfiguration,
            majorVersion,
            minorVersion,
            patchVersion,
            preReleaseIdentifier,
            savePackageConfigurationPending: false,
            anyDependenciesUpdated: false
        };

        if (!this.isValidBranch()) {
            throw new Error(`Branch ${branch} is not valid for ${this.phase} phase`);
        }

        const parsedBranchGroups = /^v(?<branchMajorVersion>\d+)\.(?<branchMinorVersion>\d+)/u.exec(
            // Helper repositories are always on the latest version branch.
            repository.dependencyType !== "helper" ? branch : `v${this.latestVersion}`
        )?.groups;

        // If this is a version branch, update the package version if required.
        if (parsedBranchGroups !== undefined) {
            const branchMajorVersion = Number(parsedBranchGroups["branchMajorVersion"]);
            const branchMinorVersion = Number(parsedBranchGroups["branchMinorVersion"]);

            // If in a version branch and version doesn't match, update it.
            if (majorVersion !== branchMajorVersion || minorVersion !== branchMinorVersion) {
                if (majorVersion !== branchMajorVersion ? majorVersion !== branchMajorVersion - 1 : minorVersion !== branchMinorVersion - 1) {
                    throw new Error(`Invalid transition from ${majorVersion}.${minorVersion} to ${branchMajorVersion}.${branchMinorVersion}`);
                }

                this.updatePackageVersion(branchMajorVersion, branchMinorVersion, 0, null);
                this.commitUpdatedPackageVersion(PACKAGE_CONFIGURATION_PATH);
            }
        }

        // eslint-disable-next-line no-param-reassign -- Repository is necessarily updated as part of building publish state.
        repository.workingVersion = `${majorVersion}.${minorVersion}`;

        for (const dependencies of [packageConfiguration.devDependencies ?? {}, packageConfiguration.dependencies ?? {}]) {
            for (const dependencyPackageName of Object.keys(dependencies)) {
                const dependencyRepositoryName = this.dependencyRepositoryName(dependencyPackageName);

                // Dependency repository name is null if dependency is not within the organization; ignore if working versions are different.
                if (dependencyRepositoryName !== null && this.configuration.repositories[dependencyRepositoryName].workingVersion === repository.workingVersion) {
                    this.logger.trace(`Organization dependency ${dependencyPackageName} from package configuration`);

                    if (this.#isOrganizationDependencyUpdated(phaseDateTime, dependencyRepositoryName, false)) {
                        // Update dependency version to match latest update.
                        dependencies[dependencyPackageName] = this.dependencyVersionFor(dependencyRepositoryName);

                        this.#repositoryPublishState.anyDependenciesUpdated = true;
                    }
                }
            }
        }

        // Saving the package configuration would affect check for any changes so defer it.
        this.#repositoryPublishState.savePackageConfigurationPending = this.#repositoryPublishState.anyDependenciesUpdated;

        if (repository.additionalDependencies !== undefined) {
            for (const additionalDependencyRepositoryName of repository.additionalDependencies) {
                this.logger.trace(`Organization dependency ${this.getPackageName(additionalDependencyRepositoryName)} from additional dependencies`);

                if (this.#isOrganizationDependencyUpdated(phaseDateTime, additionalDependencyRepositoryName, true)) {
                    this.#repositoryPublishState.anyDependenciesUpdated = true;
                }
            }
        }
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
            await i18nCoreInit(I18nEnvironments.CLI, false);

            const startDirectory = process.cwd();

            for (const [repositoryName, repository] of Object.entries(this.configuration.repositories)) {
                if (this.publishState.repositoryName === undefined || this.publishState.repositoryName === repositoryName) {
                    this.publishState.repositoryName = repositoryName;

                    // All repository directories are expected to be children of the parent of this repository.
                    const directory = `../${repository.directory ?? repositoryName}`;

                    if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
                        this.logger.info(`Repository ${repositoryName}...`);

                        try {
                            process.chdir(directory);

                            this.#buildPublishState(repositoryName, repository);

                            // eslint-disable-next-line no-await-in-loop -- Next iteration requires previous to finish.
                            await this.publish();

                            delete this.publishState.repositoryName;
                            delete this.publishState.step;
                        } finally {
                            // Return to the start directory.
                            process.chdir(startDirectory);

                            this.#saveConfiguration();
                        }
                        // Non-external repositories may be private and not accessible to all developers.
                    } else if (repository.dependencyType === "external") {
                        throw new Error(`Repository ${repositoryName} not found`);
                    }
                }
            }

            delete this.configuration.publishState;

            this.finalizeAll();

            this.#saveConfiguration();

            if (this.phase !== "alpha") {
                this.commitModified(`Published ${this.phase} release.`, SHARED_CONFIGURATION_PATH);
            }
        } catch (e) {
            this.logger.error(e);
        }
    }

    /**
     * Finalize publishing all repositories.
     */
    protected finalizeAll(): void {
    }
}
