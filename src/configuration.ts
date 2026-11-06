import { LocalAppDataStorage, type LogLevelKey, logLevelOf, omit, pick } from "@aidc-toolkit/core";
import type { Logger } from "tslog";
import type { Phase } from "./phase.js";
import {
    type LocalRepository,
    type RawRepository,
    Repository,
    type RepositoryPublishState,
    type SharedRepository
} from "./repository.js";
import type { LocalVersionState, SharedVersionState, VersionState } from "./version-state.js";

const SHARED_CONFIGURATION_KEY = "config/publisher";
const LOCAL_CONFIGURATION_KEY = "config/publisher.local";

/**
 * Shared configuration path.
 */
export const SHARED_CONFIGURATION_PATH = `${SHARED_CONFIGURATION_KEY}.json`;

/**
 * Shared configuration.
 */
interface SharedConfiguration {
    /**
     * Ordered list of versions. Each version's branch can only be pushed to the next; only the last can be pushed to
     * main.
     */
    readonly versions: string[];

    /**
     * Organization that owns the repositories.
     */
    readonly organization: string;

    /**
     * Repositories.
     */
    readonly repositories: Readonly<Record<string, SharedRepository>>;
}

/**
 * Publish state.
 */
export interface PublishState<TPhase extends Phase | undefined> {
    /**
     * Current phase in publication or undefined if not publishing.
     */
    readonly phase: TPhase;

    /**
     * Repository publish states.
     */
    readonly repositoryPublishStates: Record<string, RepositoryPublishState>;

    /**
     * Current repository name in publication.
     */
    repositoryName?: string;

    /**
     * Current step in publication.
     */
    step?: string;
}

/**
 * Local configuration.
 */
interface LocalConfiguration<TPhase extends Phase | undefined> {
    /**
     * Registry hosting organization's alpha repositories.
     */
    readonly alphaRegistry: string;

    /**
     * Log level.
     */
    readonly logLevel?: LogLevelKey;

    /**
     * Additional arguments for externally run commands.
     */
    readonly additionalArgs?: Readonly<Record<string, string[] | undefined>>;

    /**
     * Publish state.
     */
    publishState?: PublishState<TPhase>;

    /**
     * Repositories.
     */
    readonly repositories: Readonly<Record<string, LocalRepository>>;
}

/**
 * Raw configuration.
 */
interface RawConfiguration<TPhase extends Phase | undefined> extends SharedConfiguration, LocalConfiguration<TPhase> {
    /**
     * Repositories.
     */
    readonly repositories: Readonly<Record<string, RawRepository>>;
}

/**
 * Configuration.
 */
export class Configuration<TPhase extends Phase | undefined> implements Required<RawConfiguration<TPhase>> {
    /**
     * Phase.
     */
    readonly #phase: TPhase;

    /**
     * Logger.
     */
    readonly #logger: Logger<object>;

    /**
     * If true, output what would be produced rather than producing it.
     */
    readonly #isDryRun: boolean;

    /**
     * Raw configuration.
     */
    readonly #raw: RawConfiguration<TPhase> & { publishState: PublishState<TPhase> };

    /**
     * Repositories.
     */
    readonly #repositories: Readonly<Record<string, Repository<TPhase>>>;

    /**
     * Latest version.
     */
    readonly #latestVersion: string;

    /**
     * At organization.
     */
    readonly #atOrganization: string;

    /**
     * At organization registry parameter.
     */
    readonly #atOrganizationRegistryParameter: string;

    /**
     * Constructor.
     *
     * @param phase
     * Phase.
     *
     * @param logger
     * Logger.
     *
     * @param isDryRun
     * If true, output what would be produced rather than producing it.
     *
     * @param raw
     * Raw configuration.
     */
    private constructor(phase: TPhase, logger: Logger<object>, isDryRun: boolean, raw: RawConfiguration<TPhase> & { publishState: PublishState<TPhase> }) {
        this.#phase = phase;
        this.#logger = logger;
        this.#isDryRun = isDryRun;
        this.#raw = raw;

        this.#repositories = Object.fromEntries(Object.entries(raw.repositories).map(([name, rawRepository]) =>
            [name, new Repository(this, name, rawRepository)]
        ));

        this.#latestVersion = raw.versions[raw.versions.length - 1];

        const atOrganization = `@${raw.organization}`;

        this.#atOrganization = atOrganization;
        this.#atOrganizationRegistryParameter = `${atOrganization}:registry`;
    }

    /**
     * Get the phase.
     */
    get phase(): TPhase {
        return this.#phase;
    }

    /**
     * Get the logger.
     */
    get logger(): Logger<object> {
        return this.#logger;
    }

    /**
     * Determine if output what would be produced rather than producing it.
     */
    get isDryRun(): boolean {
        return this.#isDryRun;
    }

    /**
     * Get the ordered list of versions.
     */
    get versions(): string[] {
        return this.#raw.versions;
    }

    /**
     * Get the organization.
     */
    get organization(): string {
        return this.#raw.organization;
    }

    /**
     * Get the registry hosting organization's alpha repositories.
     */
    get alphaRegistry(): string {
        return this.#raw.alphaRegistry;
    }

    /**
     * Get the log level.
     */
    get logLevel(): LogLevelKey {
        return this.#raw.logLevel ?? "Info";
    }

    /**
     * Get additional arguments for externally run commands.
     */
    get additionalArgs(): never {
        throw new Error("Direct access to additional arguments forbidden");
    }

    /**
     * Get additional arguments for an externally run command.
     *
     * @param command
     * Command.
     *
     * @returns
     * Additional arguments or empty array if none.
     */
    getAdditionalArgs(command: string): string[] {
        return this.#raw.additionalArgs?.[command] ?? [];
    }

    /**
     * Get the publish state.
     */
    get publishState(): PublishState<TPhase> {
        return this.#raw.publishState;
    }

    /**
     * Get the repositories.
     */
    get repositories(): Readonly<Record<string, Repository<TPhase>>> {
        return this.#repositories;
    }

    /**
     * Get the latest version.
     */
    get latestVersion(): string {
        return this.#latestVersion;
    }

    /**
     * Get the at organization.
     */
    get atOrganization(): string {
        return this.#atOrganization;
    }

    /**
     * Get the at organization registry parameter.
     */
    get atOrganizationRegistryParameter(): string {
        return this.#atOrganizationRegistryParameter;
    }

    /**
     * Load configuration from JSON files for a phase.
     *
     * @param branch
     * Branch; must be of the format `v{$latestVersion}`.
     *
     * @param phase
     * Phase.
     *
     * @param logger
     * Logger.
     *
     * @param isDryRun
     * If true, output what would be produced rather than producing it.
     *
     * @returns
     * Configuration.
     */
    static async load<TPhase extends Phase | undefined>(branch: string, phase: TPhase, logger: Logger<object>, isDryRun: boolean): Promise<Configuration<TPhase>> {
        const appDataStorage = new (await LocalAppDataStorage)(".");

        const sharedConfigurationAppData = await appDataStorage.read(SHARED_CONFIGURATION_KEY);

        if (sharedConfigurationAppData === undefined || typeof sharedConfigurationAppData !== "object") {
            throw new Error("Shared configuration not found or not valid.");
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Assume shared configuration is valid.
        const sharedConfiguration = sharedConfigurationAppData as SharedConfiguration;

        const expectedBranch = `v${sharedConfiguration.versions[sharedConfiguration.versions.length - 1]}`;

        // Verify that the branch is the latest version.
        if (branch !== expectedBranch) {
            throw new Error(`Publisher branch ${branch} must be ${expectedBranch}`);
        }

        const localConfigurationAppData = await appDataStorage.read(LOCAL_CONFIGURATION_KEY);

        if (localConfigurationAppData === undefined || typeof localConfigurationAppData !== "object") {
            throw new Error("Local configuration not found or not valid.");
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Assume local configuration is valid.
        const localConfiguration = localConfigurationAppData as LocalConfiguration<TPhase>;

        const logLevel = localConfiguration.logLevel ?? "Info";

        // eslint-disable-next-line no-param-reassign -- Log level is adjusted to align with configuration.
        logger.settings.minLevel = logLevelOf(logLevel);

        let publishState = localConfiguration.publishState;

        if (publishState === undefined) {
            publishState = {
                phase,
                repositoryPublishStates: {}
            };
        } else if (publishState.phase !== phase) {
            throw new Error(`Previous publication phase ${publishState.phase} not completed`);
        }

        // Merge shared and local configurations.
        return new Configuration(phase, logger, isDryRun, {
            ...sharedConfiguration,
            ...localConfiguration,
            logLevel,
            additionalArgs: localConfiguration.additionalArgs ?? {},
            publishState,
            repositories: Object.fromEntries(Object.entries(sharedConfiguration.repositories).map<[string, RawRepository]>(([repositoryName, sharedRepository]) => {
                const localRepository = localConfiguration.repositories[repositoryName] ?? {
                    versionStates: {}
                };

                return [repositoryName, {
                    ...sharedRepository,
                    ...localRepository,
                    versionStates: Object.fromEntries(Object.entries(localRepository.versionStates).map<[string, VersionState]>(([version, localVersionState]) => {
                        const sharedVersionState = sharedRepository.versionStates[version] ?? {
                            phaseStates: {}
                        };

                        return [version, {
                            ...sharedVersionState,
                            ...localVersionState,
                            phaseStates: {
                                ...localVersionState.phaseStates,
                                ...sharedVersionState.phaseStates
                            }
                        }];
                    }))
                }];
            }))
        });
    }

    /**
     * Save the configuration.
     *
     * @param isComplete
     * If true, publication is complete.
     */
    async save(isComplete: boolean): Promise<void> {
        const rawConfiguration = !isComplete ? this.#raw : omit(this.#raw, "publishState");

        const sharedConfiguration: SharedConfiguration = {
            ...pick(rawConfiguration as SharedConfiguration, "versions", "organization"),
            repositories: Object.fromEntries(Object.entries(rawConfiguration.repositories as SharedConfiguration["repositories"]).map<[string, SharedRepository]>(([repositoryName, repository]) => [repositoryName, {
                ...pick(repository, "directory", "dependencyType", "additionalDependencies", "excludePaths"),
                versionStates: Object.fromEntries(Object.entries(repository.versionStates).map<[string, SharedVersionState]>(([version, versionState]) => [version, {
                    phaseStates: pick(versionState.phaseStates, "beta", "prod")
                }]).filter(([_version, versionState]) => Object.keys(versionState.phaseStates).length !== 0))
            }]))
        };

        const localConfiguration: LocalConfiguration<TPhase> = {
            ...pick(rawConfiguration as LocalConfiguration<TPhase>, "alphaRegistry", "logLevel", "additionalArgs", "publishState"),
            repositories: Object.fromEntries(Object.entries(rawConfiguration.repositories as LocalConfiguration<TPhase>["repositories"]).map<[string, LocalRepository]>(([repositoryName, repository]) => [repositoryName, {
                versionStates: Object.fromEntries(Object.entries(repository.versionStates).map<[string, LocalVersionState]>(([version, versionState]) => [version, {
                    phaseStates: pick(versionState.phaseStates, "alpha")
                }]))
            }]))
        };

        if (this.#isDryRun) {
            this.#logger.debug(`Dry run: Saving shared configuration\n${JSON.stringify(sharedConfiguration, null, 2)}\n`);
            this.#logger.debug(`Dry run: Saving local configuration\n${JSON.stringify(localConfiguration, null, 2)}\n`);
        } else {
            const appDataStorage = new (await LocalAppDataStorage)(".");

            await appDataStorage.write(SHARED_CONFIGURATION_KEY, sharedConfiguration, true);
            await appDataStorage.write(LOCAL_CONFIGURATION_KEY, localConfiguration, true);
        }
    }
}
