import { type ParsedVersion, parseVersion, pick } from "@aidc-toolkit/core";
import * as fs from "node:fs";
import type { Configuration } from "./configuration.js";
import { PACKAGE_CONFIGURATION_PATH, type PackageConfiguration } from "./package-configuration.js";
import { NEXT_PHASE, type Phase, type PhaseState } from "./phase.js";
import type { LocalVersionState, SharedVersionState, VersionState } from "./version-state.js";

/**
 * Configuration path for constant VERSION.
 */
const SOURCE_VERSION_PATH = "src/version.ts";

/**
 * Dependency type.
 *
 * - external
 *   - External (public) dependency of one or more other repositories
 *   - Installed from NPM
 * - internal
 *   - Internal (private) dependency of one or more other repositories
 *   - Installed from GitHub
 *   - May require "prepare" script (https://docs.npmjs.com/cli/using-npm/scripts)
 *   - May require GitHub authentication
 * - application
 *   - Published application
 * - helper
 *   - Internal helper
 *   - Not subject to rigid publication process
 */
export type DependencyType = "external" | "internal" | "application" | "helper";

/**
 * Shared repository configuration.
 */
export interface SharedRepository {
    /**
     * Directory in which repository resides, if different from repository name.
     */
    readonly directory?: string;

    /**
     * Dependency type.
     */
    readonly dependencyType: DependencyType;

    /**
     * Additional organization dependencies not included in package configuration.
     */
    readonly additionalDependencies?: readonly string[];

    /**
     * Paths to exclude when checking for changes.
     */
    readonly excludePaths?: readonly string[];

    /**
     * Version states.
     */
    readonly versionStates: Readonly<Record<string, SharedVersionState>>;
}

/**
 * Local repository configuration.
 */
export interface LocalRepository {
    /**
     * Version states.
     */
    readonly versionStates: Readonly<Record<string, LocalVersionState>>;
}

/**
 * Repository.
 */
export interface RawRepository extends SharedRepository, LocalRepository {
    /**
     * Version states.
     */
    readonly versionStates: Record<string, VersionState>;
}

/**
 * Repository publish state.
 */
export interface RepositoryPublishState {
    /**
     * Working version.
     */
    workingVersion: string;

    /**
     * Organization dependency package names included in package configuration.
     */
    dependencyPackageNames: string[];
}

/**
 * Repository.
 */
export class Repository<TPhase extends Phase | undefined> implements RawRepository {
    /**
     * Configuration.
     */
    readonly #configuration: Configuration<TPhase>;

    /**
     * Repository name.
     */
    readonly #name: string;

    /**
     * Raw repository.
     */
    readonly #raw: RawRepository;

    /**
     * Package name.
     */
    readonly #packageName: string;

    /**
     * Package configuration.
     */
    #packageConfiguration!: PackageConfiguration;

    /**
     * Parsed version.
     */
    #parsedVersion!: ParsedVersion;

    /**
     * True if any dependencies, including additional, have been updated.
     */
    #anyDependenciesUpdated!: boolean;

    /**
     * Constructor.
     *
     * @param configuration
     * Configuration.
     *
     * @param name
     * Repository name.
     *
     * @param raw
     * Raw repository.
     */
    constructor(configuration: Configuration<TPhase>, name: string, raw: RawRepository) {
        this.#configuration = configuration;
        this.#name = name;
        this.#raw = raw;
        this.#packageName = `${configuration.atOrganization}/${name}`;
    }

    /**
     * Get the repository name.
     */
    get name(): string {
        return this.#name;
    }

    /**
     * Get the package name.
     */
    get packageName(): string {
        return this.#packageName;
    }

    /**
     * Get the directory in which repository resides.
     */
    get directory(): string {
        return this.#raw.directory ?? this.#name;
    }

    /**
     * Get the dependency type.
     */
    get dependencyType(): DependencyType {
        return this.#raw.dependencyType;
    }

    /**
     * Get the additional organization dependencies not included in package configuration.
     */
    get additionalDependencies(): readonly string[] {
        return this.#raw.additionalDependencies ?? [];
    }

    /**
     * Get the paths to exclude when checking for changes.
     */
    get excludePaths(): readonly string[] {
        return this.#raw.excludePaths ?? [];
    }

    /**
     * Get additional arguments for externally run commands.
     */
    get versionStates(): never {
        throw new Error("Direct access to version states forbidden");
    }

    /**
     * Get the package configuration.
     */
    get packageConfiguration(): PackageConfiguration {
        return this.#packageConfiguration;
    }

    /**
     * Get the parsed version.
     */
    get parsedVersion(): ParsedVersion {
        return this.#parsedVersion;
    }

    /**
     * Determine if any dependencies, including additional, have been updated.
     */
    get anyDependenciesUpdated(): boolean {
        return this.#anyDependenciesUpdated;
    }

    /**
     * Get the repository publish state.
     */
    get repositoryPublishState(): RepositoryPublishState {
        return this.#configuration.publishState.repositoryPublishStates[this.name];
    }

    /**
     * Get the working version.
     */
    get workingVersion(): string {
        return this.repositoryPublishState.workingVersion;
    }

    /**
     * Get the version state.
     */
    get versionState(): VersionState {
        const workingVersion = this.workingVersion;

        let versionState = this.#raw.versionStates[workingVersion] as VersionState | undefined;

        // Set the version state if undefined.
        if (versionState === undefined) {
            versionState = {
                phaseStates: {}
            };

            this.#raw.versionStates[workingVersion] = versionState;
        }

        return versionState;
    }

    /**
     * Get a phase state.
     *
     * @param isRequired
     * True if phase state is required.
     *
     * @param phase
     * Phase.
     *
     * @returns
     * Phase state.
     */
    getPhaseState<IsRequired extends boolean>(isRequired: IsRequired, phase = this.#configuration.publishState.phase): IsRequired extends true ? PhaseState : PhaseState | undefined {
        const phaseState = phase !== undefined ? this.versionState.phaseStates[phase] : undefined;

        if (isRequired && phaseState === undefined) {
            throw new Error(`Phase state for phase ${phase} is required but undefined.`);
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Type is determined above.
        return phaseState as IsRequired extends true ? PhaseState : PhaseState | undefined;
    }

    /**
     * Get a phase date/time.
     *
     * @param isRequired
     * True if phase date/time is required.
     *
     * @returns
     * Phase date/time or undefined if phase never before published.
     */
    getPhaseDateTime<IsRequired extends boolean>(isRequired: IsRequired): IsRequired extends true ? Date : Date | undefined {
        let phase: Phase | null | undefined = this.#configuration.publishState.phase;

        if (phase === undefined) {
            throw new Error("Phase must be defined to get phase date/time");
        }

        const versionState = this.versionState;

        let phaseDateTime;

        do {
            const dateTime = versionState.phaseStates[phase]?.dateTime;

            if (phaseDateTime === undefined || (dateTime !== undefined && phaseDateTime.getTime() < dateTime.getTime())) {
                // Phase date/time is the latest of current and all subsequent phases.
                phaseDateTime = dateTime;
            }
        } while ((phase = NEXT_PHASE[phase]) !== null);

        if (isRequired && phaseDateTime === undefined) {
            throw new Error(`Repository ${this.name} does not have phase date/time for ${phase} phase`);
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Type is determined above.
        return phaseDateTime as IsRequired extends true ? Date : Date | undefined;
    }

    /**
     * Update the phase date/time, rounded up to the next second for Git resolution alignment.
     */
    updatePhaseDateTime(): void {
        const now = new Date();

        // Git resolution is one second so round up to next second to ensure that comparisons work as expected.
        this.getPhaseState(true).dateTime = new Date(now.getTime() - now.getMilliseconds() + 1000);
    }

    /**
     * Start publishing this repository.
     */
    startPublish(): void {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Package configuration format is known.
        const packageConfiguration = JSON.parse(fs.readFileSync(PACKAGE_CONFIGURATION_PATH).toString()) as PackageConfiguration;

        if (packageConfiguration.name !== this.packageName) {
            throw new Error(`Package name in package.json (${packageConfiguration.name}) does not match repository package name (${this.packageName})`);
        }

        const parsedVersion = parseVersion(packageConfiguration.version);

        this.#packageConfiguration = packageConfiguration;
        this.#parsedVersion = parsedVersion;

        const publishState = this.#configuration.publishState;

        publishState.repositoryPublishStates[this.name] = {
            workingVersion: `${parsedVersion.majorVersion}.${parsedVersion.minorVersion}`,
            dependencyPackageNames: []
        };

        const phase = publishState.phase;

        if (phase !== undefined) {
            const versionState = this.versionState;

            let phaseState = versionState.phaseStates[phase];

            // Create phase state if necessary.
            if (phaseState === undefined) {
                // Default phase state will be replaced almost immediately.
                phaseState = {
                    version: "0.0.0"
                };

                versionState.phaseStates[phase] = phaseState;
            }
        }
    }

    /**
     * Update the package version.
     *
     * @param propagateToPhaseState
     * If true, version change should be propagated to phase state.
     *
     * @param majorVersion
     * Major version.
     *
     * @param minorVersion
     * Minor version.
     *
     * @param patchVersion
     * Patch version.
     *
     * @param preReleaseIdentifier
     * Pre-release identifier.
     *
     * @param preReleaseDateTime
     * Pre-release date/time. Modifies pre-release identifier if provided.
     *
     * @returns
     * Updated package version.
     */
    updatePackageVersion(propagateToPhaseState: boolean, majorVersion: number, minorVersion: number, patchVersion: number, preReleaseIdentifier?: "pending" | "alpha" | "beta", preReleaseDateTime?: Date): string {
        const baseVersion = `${majorVersion}.${minorVersion}.${patchVersion}${preReleaseIdentifier !== undefined ? `-${preReleaseIdentifier}` : ""}`;

        const previousParsedVersion = this.#parsedVersion;

        const version = preReleaseDateTime === undefined ? baseVersion : `${baseVersion}.${preReleaseDateTime.toISOString().replaceAll(/\D/ug, "").substring(0, 12)}`;

        this.packageConfiguration.version = version;

        this.savePackageConfiguration();

        this.#parsedVersion = {
            majorVersion,
            minorVersion,
            patchVersion,
            preReleaseIdentifier,
            preReleaseDateTime
        };

        if (previousParsedVersion.majorVersion !== majorVersion || previousParsedVersion.minorVersion !== minorVersion || previousParsedVersion.patchVersion !== patchVersion || previousParsedVersion.preReleaseIdentifier !== preReleaseIdentifier) {
            // Base version has changed; regenerate source version file if not a helper repository.
            if (this.dependencyType !== "helper") {
                if (this.#configuration.isDryRun) {
                    this.#configuration.logger.info(`Dry run: Update source version declaration file with version ${version}`);
                } else {
                    fs.writeFileSync(SOURCE_VERSION_PATH, [
                        "/**",
                        " * Repository version, updated automatically during publication.",
                        " */",
                        `export const VERSION = "${baseVersion}";`,
                        ""
                    ].join("\n"));
                }
            }

            if (previousParsedVersion.majorVersion !== majorVersion || previousParsedVersion.minorVersion !== minorVersion) {
                // Working version has changed; create new repository publish state.
                this.#configuration.publishState.repositoryPublishStates[this.name] = {
                    workingVersion: `${majorVersion}.${minorVersion}`,
                    dependencyPackageNames: []
                };
            }
        }

        if (propagateToPhaseState) {
            this.getPhaseState(true).version = version;
        }

        return version;
    }

    /**
     * Save the package configuration file.
     */
    savePackageConfiguration(): void {
        if (this.#configuration.isDryRun) {
            this.#configuration.logger.info(`Dry run: Saving package configuration\n${JSON.stringify(pick(this.#packageConfiguration, "name", "version", "devDependencies", "dependencies"), null, 2)}\n`);
        } else {
            fs.writeFileSync(PACKAGE_CONFIGURATION_PATH, `${JSON.stringify(this.#packageConfiguration, null, 2)}\n`);
        }
    }

    /**
     * Align with branch if branch is a version branch.
     *
     * @param branch
     * Branch.
     */
    alignWithBranch(branch: string): void {
        const configuration = this.#configuration;
        const phase = configuration.publishState.phase;

        if (phase !== undefined) {
            const parsedBranchGroups = /^v(?<branchMajorVersion>\d+)\.(?<branchMinorVersion>\d+)/u.exec(branch)?.groups;

            // If this is a version branch, update the package version if required.
            if (parsedBranchGroups !== undefined) {
                const branchMajorVersion = Number(parsedBranchGroups["branchMajorVersion"]);
                const branchMinorVersion = Number(parsedBranchGroups["branchMinorVersion"]);
                const branchVersion = `${branchMajorVersion}.${branchMinorVersion}`;

                if (!this.#configuration.versions.includes(branchVersion)) {
                    throw new Error(`Branch version ${branchVersion} is not listed in configuration versions`);
                }

                const parsedVersion = this.parsedVersion;

                // If version doesn't match, branch is new.
                if (parsedVersion.majorVersion !== branchMajorVersion || parsedVersion.minorVersion !== branchMinorVersion) {
                    if (phase !== "alpha") {
                        throw new Error("Version transition not permitted except in alpha phase");
                    }

                    if (parsedVersion.majorVersion !== branchMajorVersion ? parsedVersion.majorVersion !== branchMajorVersion - 1 || branchMinorVersion !== 0 : parsedVersion.minorVersion !== branchMinorVersion - 1) {
                        throw new Error(`Invalid transition from ${parsedVersion.majorVersion}.${parsedVersion.minorVersion} to ${branchMajorVersion}.${branchMinorVersion}`);
                    }

                    // Update package version with pre-release identifier "pending"; alpha publisher will commit it.
                    this.updatePackageVersion(false, branchMajorVersion, branchMinorVersion, 0, "pending");
                }
            }
        }
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
        return phaseDateTime === undefined || phaseDateTime.getTime() < this.#configuration.repositories[dependencyRepositoryName].getPhaseDateTime(true).getTime();
    }

    /**
     * Update package configuration if any organization dependencies have been updated.
     *
     * @param dependencyVersionFor
     * Callback to determine the version to use for the dependency repository.
     *
     * @returns
     * Set of organization dependency package names that were not updated but should be subjected to "npm update".
     */
    updateOrganizationDependencies(dependencyVersionFor: (dependencyRepositoryName: string) => string): Set<string> {
        const updateDependencyPackageNamesSet = new Set<string>();

        const configuration = this.#configuration;
        const phase = configuration.publishState.phase;

        if (phase !== undefined) {
            const logger = configuration.logger;
            const packageConfiguration = this.packageConfiguration;
            const parsedVersion = this.parsedVersion;
            const phaseDateTime = this.getPhaseDateTime(true);

            const dependencyPackageNames = this.repositoryPublishState.dependencyPackageNames;

            let anyDependenciesUpdated = false;

            for (const dependencies of [packageConfiguration.devDependencies ?? {}, packageConfiguration.dependencies ?? {}]) {
                for (const dependencyPackageName of Object.keys(dependencies)) {
                    const dependencyRepositoryName = configuration.dependencyRepositoryName(dependencyPackageName);

                    // Dependency repository name is null if dependency is not within the organization.
                    if (dependencyRepositoryName !== null) {
                        logger.trace(`Organization dependency ${dependencyPackageName} from package configuration`);

                        dependencyPackageNames.push(dependencyPackageName);

                        const dependencyPhaseState = configuration.repositories[dependencyRepositoryName].getPhaseState(true);
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
                                    (dependencyParsedVersion.patchVersion === parsedVersion.patchVersion + 1 && phase === "alpha" && dependencyParsedVersion.preReleaseIdentifier === "alpha" && parsedVersion.preReleaseIdentifier !== "alpha");
                            }
                        }

                        if (!validVersionSequence) {
                            throw new Error(`Repository version ${packageConfiguration.version} is less than ${dependencyRepositoryName} dependency version ${dependencyVersion}`);
                        }

                        if (this.#isOrganizationDependencyUpdated(phaseDateTime, dependencyRepositoryName)) {
                            logger.trace(`Dependency repository ${dependencyRepositoryName} updated`);

                            const dependencyRepositoryVersion = dependencyVersionFor(dependencyRepositoryName);

                            if (dependencies[dependencyPackageName] !== dependencyRepositoryVersion) {
                                // Dependency will be updated alongside all other dependencies.
                                dependencies[dependencyPackageName] = dependencyRepositoryVersion;
                            } else {
                                updateDependencyPackageNamesSet.add(dependencyPackageName);

                                const dependencyRepositoryPublishState = configuration.publishState.repositoryPublishStates[dependencyRepositoryName];

                                for (const dependencyDependencyPackageName of dependencyRepositoryPublishState.dependencyPackageNames) {
                                    updateDependencyPackageNamesSet.add(dependencyDependencyPackageName);
                                }
                            }

                            anyDependenciesUpdated = true;
                        }
                    }
                }
            }

            if (anyDependenciesUpdated) {
                this.savePackageConfiguration();
            }

            for (const additionalDependencyRepositoryName of this.additionalDependencies) {
                logger.trace(`Organization dependency ${additionalDependencyRepositoryName} from additional dependencies`);

                if (this.#isOrganizationDependencyUpdated(phaseDateTime, additionalDependencyRepositoryName)) {
                    logger.trace(`Additional dependency repository ${additionalDependencyRepositoryName} updated`);

                    anyDependenciesUpdated = true;
                }
            }

            this.#anyDependenciesUpdated = anyDependenciesUpdated;
        }

        return updateDependencyPackageNamesSet;
    }
}
