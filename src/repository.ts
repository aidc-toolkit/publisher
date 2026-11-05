import { type ParsedVersion, parseVersion, pick } from "@aidc-toolkit/core";
import fs from "node:fs";
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
}
