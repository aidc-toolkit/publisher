import { type LogLevelKey, pick } from "@aidc-toolkit/core";
import { FileAppDataStorage } from "@aidc-toolkit/core/src/file-app-data-storage.js";
import type { Logger } from "tslog";

const SHARED_CONFIGURATION_KEY = "config/publisher";
const LOCAL_CONFIGURATION_KEY = "config/publisher.local";

export const SHARED_CONFIGURATION_PATH = `${SHARED_CONFIGURATION_KEY}.json`;

/**
 * Phase.
 */
export type Phase = "alpha" | "beta" | "prod";

/**
 * Next phase mapping.
 */
export const NEXT_PHASE: Readonly<Record<Phase, Phase | null>> = {
    alpha: "beta",
    beta: "prod",
    prod: null
};

/**
 * Previous phase mapping.
 */
export const PREVIOUS_PHASE: Readonly<Record<Phase, Phase | null>> = {
    alpha: null,
    beta: "alpha",
    prod: "beta"
};

/**
 * Phase state.
 */
export interface PhaseState {
    /**
     * Version the phase was last published.
     */
    version: string;

    /**
     * Date/time the phase was last published.
     */
    dateTime?: Date;
}

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
interface SharedRepository {
    /**
     * Directory in which repository resides, if different from repository name.
     */
    readonly directory?: string;

    /**
     * Dependency type, dictating how it is published.
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
     * Beta and production phase states.
     */
    readonly phaseStates?: Readonly<Partial<Record<"beta" | "prod", PhaseState>>>;
}

/**
 * Local repository configuration.
 */
interface LocalRepository {
    /**
     * Working version of local repository (major and minor versions only).
     */
    workingVersion: string;

    /**
     * Organization dependency package names included in package configuration, updated during build.
     */
    dependencyPackageNames?: string[];

    /**
     * Alpha phase state.
     */
    readonly phaseStates?: Readonly<Partial<Record<"alpha", PhaseState>>>;
}

/**
 * Repository.
 */
export interface Repository extends SharedRepository, LocalRepository {
    /**
     * Phase states.
     */
    readonly phaseStates: Partial<Record<Phase, PhaseState>>;
}

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
export interface PublishState<TPhase extends Phase | undefined = Phase> {
    /**
     * Current phase in publication or undefined if not publishing.
     */
    phase: TPhase;

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
interface LocalConfiguration {
    /**
     * Log level.
     */
    readonly logLevel?: LogLevelKey;

    /**
     * Additional arguments for externally run commands.
     */
    readonly additionalArgs?: Readonly<Record<string, string[] | undefined>>;

    /**
     * Registry hosting organization's alpha repositories.
     */
    readonly alphaRegistry: string;

    /**
     * Publish state.
     */
    publishState?: PublishState;

    /**
     * Repositories.
     */
    readonly repositories: Readonly<Record<string, LocalRepository>>;
}

/**
 * Configuration.
 */
export interface Configuration extends SharedConfiguration, LocalConfiguration {
    /**
     * Repositories.
     */
    readonly repositories: Readonly<Record<string, Repository>>;
}

/**
 * Load configuration from JSON files.
 *
 * @returns
 * Configuration.
 */
export async function loadConfiguration(): Promise<Configuration> {
    const appDataStorage = new FileAppDataStorage(".");

    const sharedConfigurationAppData = await appDataStorage.read(SHARED_CONFIGURATION_KEY);

    if (sharedConfigurationAppData === undefined || typeof sharedConfigurationAppData !== "object") {
        throw new Error("Shared configuration not found or not valid.");
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Assume shared configuration is valid.
    const sharedConfiguration = sharedConfigurationAppData as SharedConfiguration;

    const localConfigurationAppData = await appDataStorage.read(LOCAL_CONFIGURATION_KEY);

    if (localConfigurationAppData === undefined || typeof localConfigurationAppData !== "object") {
        throw new Error("Local configuration not found or not valid.");
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Assume local configuration is valid.
    const localConfiguration = localConfigurationAppData as LocalConfiguration;

    // Merge shared and local configurations.
    return {
        ...sharedConfiguration,
        ...localConfiguration,
        repositories: Object.fromEntries(Object.entries(sharedConfiguration.repositories).map(([repositoryName, sharedRepository]) => {
            const localRepository = localConfiguration.repositories[repositoryName] ?? {
                workingVersion: ""
            };

            return [repositoryName, {
                ...sharedRepository,
                ...localRepository,
                phaseStates: {
                    ...sharedRepository.phaseStates,
                    ...localRepository.phaseStates
                }
            }];
        }))
    };
}

/**
 * Save the configuration.
 *
 * @param configuration
 * Configuration.
 *
 * @param logger
 * Logger.
 *
 * @param dryRun
 * If true, outputs to logger rather than file.
 */
export async function saveConfiguration(configuration: Configuration, logger: Logger<object>, dryRun: boolean): Promise<void> {
    const sharedConfiguration: SharedConfiguration = {
        ...pick(configuration as SharedConfiguration, "versions", "organization"),
        repositories: Object.fromEntries(Object.entries(configuration.repositories).map(([repositoryName, repository]) => [repositoryName, {
            ...pick(repository as SharedRepository, "directory", "dependencyType", "additionalDependencies", "excludePaths"),
            phaseStates: pick(repository.phaseStates as NonNullable<SharedRepository["phaseStates"]>, "beta", "prod")
        }]))
    };

    const localConfiguration: LocalConfiguration = {
        ...pick(configuration as LocalConfiguration, "logLevel", "additionalArgs", "alphaRegistry", "publishState"),
        repositories: Object.fromEntries(Object.entries(configuration.repositories).map(([repositoryName, repository]) => [repositoryName, {
            ...pick(repository as LocalRepository, "workingVersion", "dependencyPackageNames"),
            phaseStates: pick(repository.phaseStates as NonNullable<LocalRepository["phaseStates"]>, "alpha")
        }]))
    };

    if (dryRun) {
        logger.debug(`Dry run: Saving shared configuration\n${JSON.stringify(sharedConfiguration, null, 2)}\n`);
        logger.debug(`Dry run: Saving local configuration\n${JSON.stringify(localConfiguration, null, 2)}\n`);
    } else {
        const appDataStorage = new FileAppDataStorage(".");

        await appDataStorage.write(SHARED_CONFIGURATION_KEY, sharedConfiguration);
        await appDataStorage.write(LOCAL_CONFIGURATION_KEY, localConfiguration);
    }
}
