import { DEFAULT_LANGUAGE } from "@aidc-toolkit/core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import { Publisher, RunOptions } from "./publisher.js";
import type { Repository } from "./repository.js";

/**
 * Alpha release publisher.
 */
class AlphaPublisher extends Publisher<"alpha"> {
    /**
     * If true, publish fast, skipping unnecessary checks.
     */
    readonly #fast: boolean;

    /**
     * If true, update all dependencies automatically.
     */
    readonly #updateAll: boolean;

    /**
     * Constructor.
     *
     * If true, outputs what would be produced rather than producing it.
     *
     * @param fast
     * If true, publish fast, skipping unnecessary checks.
     *
     * @param updateAll
     * If true, update all dependencies automatically.
     *
     * @param isDryRun
     * If true, output what would be produced rather than producing it.
     */
    constructor(fast: boolean, updateAll: boolean, isDryRun: boolean) {
        if (fast && updateAll) {
            throw new Error("Cannot specify both --fast and --update-all");
        }

        super("alpha", isDryRun);

        this.#fast = fast;
        this.#updateAll = updateAll;
    }

    /**
     * @inheritDoc
     */
    protected override getDependencyVersion(dependencyRepository: Repository<"alpha">): string {
        // Dependency version must be from the same working version publication.
        const dependencyVersion = dependencyRepository.getPhaseState(this.repository.workingVersion).version;

        // Compatible version syntax will detect updates.
        return `^${dependencyVersion.substring(0, dependencyVersion.lastIndexOf("."))}`;
    }

    /**
     * @inheritDoc
     */
    protected override handleRemoteChanges(): boolean {
        const phaseStates = this.repository.workingVersionState.phaseStates;

        const alphaDateTime = phaseStates.alpha?.dateTime;
        const prodDateTime = phaseStates.prod?.dateTime;
        const nextBranch = this.getNextBranch();

        if (alphaDateTime !== undefined && prodDateTime !== undefined && alphaDateTime.getTime() < prodDateTime.getTime() && nextBranch !== undefined) {
            this.logger.trace("Fetching changes");

            // Fetch all changes.
            this.run(RunOptions.ParameterizeOnDryRun, false, false, "git", "fetch");

            if (nextBranch === "main") {
                this.logger.trace("Merging with main");

                // This is the latest version so merge changes that were pushed to main.
                this.run(RunOptions.ParameterizeOnDryRun, false, false, "git", "merge", "origin/main");
            }
        }

        return true;
    }

    /**
     * Parse parameter names in a resource string.
     *
     * @param s
     * Resource string.
     *
     * @returns
     * Array of parameter names.
     */
    static #parseParameterNames(s: string): string[] {
        const parameterRegExp = /\{\{.+?\}\}/ug;

        const parameterNames: string[] = [];

        let match: RegExpExecArray | null;

        while ((match = parameterRegExp.exec(s)) !== null) {
            parameterNames.push(match[1]);
        }

        return parameterNames;
    }

    /**
     * Assert that locale resources are a type match for default resources.
     *
     * @param defaultResources
     * Default resources.
     *
     * @param locale
     * Locale.
     *
     * @param localeResources
     * Locale resources.
     *
     * @param parent
     * Parent key name (set recursively).
     */
    #assertValidResources(defaultResources: object, locale: string, localeResources: object, parent?: string): void {
        const logger = this.logger;

        const defaultResourcesMap = new Map<string, object>(Object.entries(defaultResources));
        const localeResourcesMap = new Map<string, object>(Object.entries(localeResources));

        const isFullLocale = locale.includes("-");

        for (const [defaultKey, defaultValue] of defaultResourcesMap) {
            const defaultFullKey = `${parent === undefined ? "" : `${parent}.`}${defaultKey}`;

            logger.debug(`Processing default key ${defaultFullKey}`);

            if (localeResourcesMap.has(defaultKey)) {
                const localeValue = localeResourcesMap.get(defaultKey);

                const defaultValueType = typeof defaultValue;
                const localeValueType = typeof localeValue;

                if (localeValueType !== defaultValueType) {
                    // Mismatched value type is allowed when one is undefined to indicate that the resource doesn't apply in that locale.
                    if (defaultValueType !== "undefined" && localeValueType !== "undefined") {
                        throw new Error(`Mismatched value type ${localeValueType} for key ${defaultFullKey} in ${locale} resources (expected ${defaultValueType})`);
                    }
                } else if (defaultValueType === "string") {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Value is known to be string.
                    const defaultParameterNames = AlphaPublisher.#parseParameterNames(defaultValue as unknown as string);

                    logger.debug(`Default parameter names ${defaultParameterNames}`);

                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Value is known to be string.
                    const localeParameterNames = AlphaPublisher.#parseParameterNames(localeValue as unknown as string);

                    logger.debug(`Locale parameter names ${localeParameterNames}`);

                    for (const defaultParameterName of defaultParameterNames) {
                        if (!localeParameterNames.includes(defaultParameterName)) {
                            throw new Error(`Missing parameter ${defaultParameterName} for key ${defaultFullKey} in ${locale} resources`);
                        }
                    }

                    for (const localeParameterName of localeParameterNames) {
                        if (!defaultParameterNames.includes(localeParameterName)) {
                            throw new Error(`Extraneous parameter ${localeParameterName} for key ${defaultFullKey} in ${locale} resources`);
                        }
                    }
                } else if (defaultValueType === "object") {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Value is known to be object.
                    this.#assertValidResources(defaultValue, locale, localeValue!, `${parent === undefined ? "" : `${parent}.`}${defaultKey}`);
                }
            // Full locale falls back to language so ignore if missing.
            } else if (!isFullLocale) {
                throw new Error(`Missing key ${defaultFullKey} in ${locale} resources`);
            }
        }

        for (const [localeKey] of localeResourcesMap) {
            if (!defaultResourcesMap.has(localeKey)) {
                throw new Error(`Extraneous key ${parent === undefined ? "" : `${parent}.`}${localeKey} in ${locale} resources`);
            }
        }
    }

    /**
     * Check for dependency package updates for a specified target (semantic version or latest overall).
     *
     * @param target
     * Target.
     *
     * @returns
     * Updated versions mapped by package name.
     */
    private checkDependencyUpdates(target: string): Map<string, string> {
        const updatesMap = new Map<string, string>();

        for (const line of this.run(RunOptions.RunAlways, true, true, "ncu", "--target", target)) {
            if (line.startsWith(" ")) {
                const components = line.split(/ +/ug);

                updatesMap.set(components[1], components[components.length - 1]);
            }
        }

        return updatesMap;
    }

    /**
     * @inheritDoc
     */
    protected override async publish(): Promise<void> {
        const logger = this.logger;

        const repository = this.repository;
        const packageConfiguration = repository.packageConfiguration;
        const workingVersion = repository.workingVersion;

        // Check for external updates, even if there are no changes, if not in fast mode and working on the latest version.
        if (!this.#fast && workingVersion === this.configuration.latestVersion) {
            logger.trace("Checking for dependency package updates");

            const latestSemanticUpdatesMap = this.checkDependencyUpdates("semver");
            const latestUpdatesMap = this.checkDependencyUpdates("latest");

            const updatesMap = new Map<string, {
                /**
                 * Latest semantic version available.
                 */
                latestSemanticVersion?: string;

                /**
                 * Latest version available.
                 */
                latestVersion?: string;
            }>();

            for (const [packageName, latestSemanticVersion] of latestSemanticUpdatesMap) {
                logger.debug(`${packageName} latest semantic version ${latestSemanticVersion}`);

                updatesMap.set(packageName, {
                    latestSemanticVersion
                });
            }

            for (const [packageName, latestVersion] of latestUpdatesMap) {
                logger.debug(`${packageName} latest version ${latestVersion}`);

                const update = updatesMap.get(packageName);

                if (update !== undefined) {
                    update.latestVersion = latestVersion;
                } else {
                    updatesMap.set(packageName, {
                        latestVersion
                    });
                }
            }

            let savePackageConfigurationPending = false;

            for (const dependencies of [packageConfiguration.devDependencies ?? {}, packageConfiguration.dependencies ?? {}]) {
                for (const [dependencyPackageName, version] of Object.entries(dependencies)) {
                    // Ignore organization dependencies and any version that goes beyond basic compatible and approximate versions.
                    if (this.configuration.dependencyRepositoryName(dependencyPackageName) === null && (version.startsWith("^") || version.startsWith("~"))) {
                        const update = updatesMap.get(dependencyPackageName);

                        if (update !== undefined) {
                            const compatibleUpdatePending = update.latestSemanticVersion !== undefined;
                            const incompatibleUpdatePending = update.latestVersion !== undefined && update.latestVersion !== update.latestSemanticVersion;
                            const manualUpdatePending = incompatibleUpdatePending && version.includes(" ");

                            if (compatibleUpdatePending) {
                                this.logger.info(`Dependency ${dependencyPackageName} ${!this.#updateAll ? "pending update" : "updating"} from version ${version} to version ${update.latestSemanticVersion}.`);
                            }

                            if (incompatibleUpdatePending) {
                                this.logger.warn(`Dependency ${dependencyPackageName} has ${!manualUpdatePending ? "incompatible" : "manual"} update pending from version ${version} to ${update.latestVersion}.`);
                            }

                            if (this.#updateAll && !manualUpdatePending) {
                                // eslint-disable-next-line no-await-in-loop -- Can't proceed without getting an answer.
                                const updateVersion = incompatibleUpdatePending && !this.isDryRun && await this.ask(`Update ${dependencyPackageName} to 1) ${compatibleUpdatePending ? update.latestSemanticVersion : version} (${compatibleUpdatePending ? "" : "no change, "}default) or 2) ${update.latestVersion}? [1/2] `, ["1", "2"]) === "1" ? update.latestSemanticVersion : update.latestVersion;

                                if (updateVersion !== undefined) {
                                    dependencies[dependencyPackageName] = updateVersion;

                                    savePackageConfigurationPending = true;
                                }
                            }
                        }
                    }
                }
            }

            if (savePackageConfigurationPending) {
                this.repository.savePackageConfiguration();
            }
        }

        // Nothing to do if there are no changes and dependencies haven't been updated.
        if (this.anyChanges(repository.getEffectivePhaseDateTime(false)) || repository.anyDependenciesUpdated) {
            let parsedVersion = repository.parsedVersion;

            const switchToAlpha = parsedVersion.preReleaseIdentifier !== "alpha";

            if (switchToAlpha) {
                logger.trace("Switching to alpha pre-release");

                this.setOrganizationAlphaRegistry();

                // Pre-release identifier "pending" indicates that patch version should remain unchanged.
                repository.updatePackageVersion(true, parsedVersion.majorVersion, parsedVersion.minorVersion, parsedVersion.preReleaseIdentifier === "pending" ? parsedVersion.patchVersion : parsedVersion.patchVersion + 1, "alpha");

                // Parsed version is updated in previous call.
                parsedVersion = repository.parsedVersion;
            }

            if (!this.#updateAll) {
                // Update the package lock configuration to pick up any changes prior to this point.
                this.updatePackageLockConfiguration();
            } else {
                // Update all dependencies.
                this.run(RunOptions.ParameterizeOnDryRun, false, false, "npm", "update");
            }

            // Run generate source if present.
            this.run(RunOptions.SkipOnDryRun, false, false, "npm", "run", "generate-source", "--if-present");

            // Run lint and localization checks if not in fast mode.
            if (!this.#fast) {
                // Run lint if present.
                this.run(RunOptions.SkipOnDryRun, false, false, "npm", "run", "lint", "--if-present");

                const localePath = path.resolve("src/locale");

                // Check for localization.
                if (fs.existsSync(localePath) && fs.statSync(localePath).isDirectory()) {
                    logger.trace("Validating localization");

                    const localeResourcesMap = new Map<string, object>();

                    for (const entry of fs.readdirSync(localePath)) {
                        const localeEntryPath = path.resolve(localePath, entry);

                        if (fs.statSync(localeEntryPath).isDirectory()) {
                            const resourcesPath = path.resolve(localeEntryPath, "locale-resources.ts");

                            if (fs.existsSync(resourcesPath)) {
                                // eslint-disable-next-line no-await-in-loop -- Await cost is negligible.
                                const resources: unknown = await import(resourcesPath);

                                if (typeof resources !== "object" || resources === null || !("default" in resources) || typeof resources.default !== "object" || resources.default === null) {
                                    throw new Error(`${resourcesPath} is not a valid locale resources file`);
                                }

                                localeResourcesMap.set(entry, resources.default);
                            }
                        }
                    }

                    if (localeResourcesMap.size !== 0) {
                        const defaultResources = localeResourcesMap.get(DEFAULT_LANGUAGE);

                        if (defaultResources === undefined) {
                            throw new Error("Default resources file not found");
                        }

                        for (const [locale, resources] of localeResourcesMap.entries()) {
                            if (locale !== DEFAULT_LANGUAGE) {
                                this.#assertValidResources(defaultResources, locale, resources);
                            }
                        }
                    }
                }
            }

            // Run alpha build.
            this.run(RunOptions.SkipOnDryRun, false, false, "npm", "run", "build:alpha");

            // Run test if not in fast mode and present.
            if (!this.#fast) {
                this.run(RunOptions.SkipOnDryRun, false, false, "npm", "run", "test", "--if-present");
            }

            // Nothing further required if this repository is not a dependency of others.
            if (repository.dependencyType === "external" || repository.dependencyType === "internal") {
                // Package version is transient.
                const version = repository.updatePackageVersion(true, parsedVersion.majorVersion, parsedVersion.minorVersion, parsedVersion.patchVersion, "alpha", new Date());

                try {
                    // Publish to development NPM registry.
                    this.run(RunOptions.ParameterizeOnDryRun, false, false, "npm", "publish", "--tag", `alpha-${workingVersion}`);

                    const priorVersionRegExp = new RegExp(`^${parsedVersion.majorVersion}.${parsedVersion.minorVersion}.\\d+-alpha.\\d+$`, "u");

                    // Unpublish all prior alpha versions with the same working version.
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Output is a JSON array.
                    for (const priorVersion of JSON.parse(this.run(RunOptions.RunAlways, true, false, "npm", "view", packageConfiguration.name, "versions", "--json").join("\n")) as string[]) {
                        if (priorVersionRegExp.test(priorVersion) && priorVersion !== version) {
                            this.run(RunOptions.ParameterizeOnDryRun, false, false, "npm", "unpublish", `${packageConfiguration.name}@${priorVersion}`);
                        }
                    }
                } finally {
                    // Restore package version without date/time stamp but don't propagate to phase state.
                    repository.updatePackageVersion(false, parsedVersion.majorVersion, parsedVersion.minorVersion, parsedVersion.patchVersion, "alpha");
                }
            }

            repository.updatePhaseDateTime();
        }
    }
}

const argv = process.argv;

// Detailed syntax checking not required as this is an internal tool.
const publisher = new AlphaPublisher(argv.includes("--fast"), argv.includes("--update-all"), argv.includes("--dry-run"));

publisher.publishAll().catch((e: unknown) => {
    publisher.logger.error("Publisher failed", e);
    process.exit(1);
});
