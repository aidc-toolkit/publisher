import { type LogLevelKey, omit, pick, propertyAs } from "@aidc-toolkit/core";
import fs from "node:fs";
import type { Logger } from "tslog";
import sharedConfigurationJSON from "../config/publisher.json" with { type: "json" };
import localConfigurationJSON from "../config/publisher.local.json" with { type: "json" };

export const SHARED_CONFIGURATION_PATH = "config/publisher.json";
export const LOCAL_CONFIGURATION_PATH = "config/publisher.local.json";

/**
 * Phase.
 */
export type Phase = "alpha" | "beta" | "production";

/**
 * Phase state.
 */
export interface PhaseState {
    /**
     * Date/time the phase was last published.
     */
    dateTime?: Date;

    /**
     * Version; used by dependents.
     */
    version?: string | undefined;
}

/**
 * Phase state in JSON file.
 */
interface JSONPhaseState extends Omit<Readonly<PhaseState>, "dateTime"> {
    /**
     * Date/time the phase was last published, as a string.
     */
    readonly dateTime?: string;
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
 *   - May require "prepare" script( https://docs.npmjs.com/cli/using-npm/scripts)
 *   - May require GitHub authentication
 * - application
 *   - Published application
 * - helper
 *   - Internal helper
 *   - Not subject to normal publication process
 *   - May exist on any branch, but primarily on main
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
    readonly phaseStates?: Readonly<Partial<Record<"beta" | "production", PhaseState>>>;
}

/**
 * Shared repository configuration in JSON file.
 */
interface JSONSharedRepository extends Omit<Readonly<SharedRepository>, "dependencyType" | "phaseStates"> {
    /**
     * Dependency type, dictating how it is published, as a string.
     */
    readonly dependencyType: string;

    /**
     * Beta and production phase states.
     */
    readonly phaseStates?: Readonly<Partial<Record<"beta" | "production", JSONPhaseState>>>;
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
     * Alpha phase state.
     */
    readonly phaseStates?: Readonly<Partial<Record<"alpha", PhaseState>>>;
}

/**
 * Local repository configuration in JSON file.
 */
interface JSONLocalRepository extends Omit<Readonly<LocalRepository>, "phaseStates"> {
    /**
     * Alpha phase state.
     */
    readonly phaseStates?: Readonly<Partial<Record<"alpha", JSONPhaseState>>>;
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
 * Shared configuration in JSON file.
 */
interface JSONSharedConfiguration extends Omit<Readonly<SharedConfiguration>, "repositories"> {
    /**
     * Repositories.
     */
    readonly repositories: Readonly<Record<string, JSONSharedRepository>>;
}

/**
 * Publish state.
 */
export interface PublishState {
    /**
     * Current phase in publication.
     */
    phase: Phase;

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
 * Publish state in JSON file.
 */
export interface JSONPublishState extends Omit<Readonly<PublishState>, "phase"> {
    /**
     * Current phase in publication, as a string.
     */
    readonly phase: string;
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
 * Local configuration in JSON file.
 */
interface JSONLocalConfiguration extends Omit<Readonly<LocalConfiguration>, "logLevel" | "publishState" | "repositories"> {
    /**
     * Log level, as a string.
     */
    readonly logLevel?: string;

    /**
     * Publish state.
     */
    readonly publishState?: JSONPublishState;

    /**
     * Repositories.
     */
    readonly repositories: Readonly<Partial<Record<string, JSONLocalRepository>>>;
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

const jsonSharedConfiguration: JSONSharedConfiguration = sharedConfigurationJSON;
const jsonLocalConfiguration: JSONLocalConfiguration = localConfigurationJSON;

/**
 * Map JSON phase states to internal phase states.
 *
 * @param jsonPhaseStates
 * JSON phase states.
 *
 * @returns
 * Internal phase states.
 */
function fromJSONPhaseStates(jsonPhaseStates: Readonly<Partial<Record<Phase, JSONPhaseState>>> | undefined): Readonly<Partial<Record<Phase, PhaseState>>> {
    return Object.fromEntries(Object.entries(jsonPhaseStates ?? {}).map(([phase, jsonPhaseState]) => [phase, jsonPhaseState.dateTime !== undefined ?
        {
            ...jsonPhaseState,
            dateTime: new Date(jsonPhaseState.dateTime)
        } :
        jsonPhaseState]));
}

/**
 * Load configuration from JSON files.
 *
 * @returns
 * Configuration.
 */
export function loadConfiguration(): Configuration {
    // Merge shared and local configurations.
    return {
        ...jsonSharedConfiguration,
        ...omit(jsonLocalConfiguration, "logLevel", "publishState"),
        ...propertyAs<JSONLocalConfiguration, "logLevel", LogLevelKey>(jsonLocalConfiguration, "logLevel"),
        ...propertyAs<JSONLocalConfiguration, "publishState", PublishState>(jsonLocalConfiguration, "publishState"),
        repositories: Object.fromEntries(Object.entries(jsonSharedConfiguration.repositories).map(([repositoryName, jsonSharedRepository]) => {
            const jsonLocalRepository = jsonLocalConfiguration.repositories[repositoryName] ?? {
                workingVersion: ""
            };

            return [repositoryName, {
                ...jsonSharedRepository,
                ...propertyAs<JSONSharedRepository, "dependencyType", DependencyType>(jsonSharedRepository, "dependencyType"),
                ...jsonLocalRepository,
                phaseStates: {
                    ...fromJSONPhaseStates(jsonSharedRepository.phaseStates),
                    ...fromJSONPhaseStates(jsonLocalRepository.phaseStates)
                }
            }];
        }))
    };
}

/**
 * Map internal phase states to JSON phase states.
 *
 * @param phaseStates
 * Internal phase states.
 *
 * @returns
 * JSON phase states.
 */
function toJSONPhaseStates(phaseStates: Readonly<Partial<Record<Phase, PhaseState>>> | undefined): Readonly<Partial<Record<Phase, JSONPhaseState>>> {
    return Object.fromEntries(Object.entries(phaseStates ?? {}).map(([phase, phaseState]) => [phase, phaseState.dateTime !== undefined ?
        {
            ...phaseState,
            dateTime: phaseState.dateTime.toISOString()
        } :
        phaseState]
    ));
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
export function saveConfiguration(configuration: Configuration, logger: Logger<object>, dryRun: boolean): void {
    const jsonSharedConfiguration: JSONSharedConfiguration = {
        ...pick(configuration, "versions", "organization"),
        repositories: Object.fromEntries(Object.entries(configuration.repositories).map(([repositoryName, repository]) => [repositoryName, {
            ...pick(repository, "directory", "dependencyType", "additionalDependencies", "excludePaths"),
            phaseStates: toJSONPhaseStates(pick(repository.phaseStates, "beta", "production"))
        }]))
    };

    const jsonLocalConfiguration: JSONLocalConfiguration = {
        ...pick(configuration, "logLevel", "alphaRegistry", "publishState"),
        repositories: Object.fromEntries(Object.entries(configuration.repositories).map(([repositoryName, repository]) => [repositoryName, {
            ...pick(repository, "workingVersion"),
            phaseStates: toJSONPhaseStates(pick(repository.phaseStates, "alpha"))
        }]))
    };

    const saveSharedConfigurationJSON = `${JSON.stringify(jsonSharedConfiguration, null, 2)}\n`;
    const saveLocalConfigurationJSON = `${JSON.stringify(jsonLocalConfiguration, null, 2)}\n`;

    if (dryRun) {
        logger.info(`Dry run: Saving shared configuration\n${saveSharedConfigurationJSON}\n`);
        logger.info(`Dry run: Saving local configuration\n${saveLocalConfigurationJSON}\n`);
    } else {
        fs.writeFileSync(SHARED_CONFIGURATION_PATH, saveSharedConfigurationJSON);
        fs.writeFileSync(LOCAL_CONFIGURATION_PATH, saveLocalConfigurationJSON);
    }
}
