import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { Publisher, RunOptions } from "./publisher.js";

/**
 * Alpha release publisher.
 */
class AlphaPublisher extends Publisher {
    /**
     * If true, update all dependencies automatically.
     */
    readonly #updateAll: boolean;

    /**
     * Constructor.
     *
     * If true, outputs what would be run rather than running it.
     *
     * @param updateAll
     * If true, update all dependencies automatically.
     *
     * @param dryRun
     * If true, outputs what would be run rather than running it.
     */
    constructor(updateAll: boolean, dryRun: boolean) {
        super("alpha", dryRun);

        this.#updateAll = updateAll;
    }

    /**
     * @inheritDoc
     */
    protected override dependencyVersionFor(dependencyRepositoryName: string): string {
        // Lock to version against which package is being developed.
        const phaseStateVersion = this.configuration.repositories[dependencyRepositoryName].phaseStates.alpha?.version;

        if (phaseStateVersion === undefined) {
            throw new Error(`*** Internal error *** Version not set for dependency ${dependencyRepositoryName}`);
        }

        return phaseStateVersion;
    }

    /**
     * @inheritDoc
     */
    protected override isValidBranch(): boolean {
        // Any branch is valid for alpha publication.
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
     * Assert that locale resources are a type match for English (default) resources.
     *
     * @param enResources
     * English resources.
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
    static #assertValidResources(enResources: object, locale: string, localeResources: object, parent?: string): void {
        const enResourcesMap = new Map<string, object>(Object.entries(enResources));
        const localeResourcesMap = new Map<string, object>(Object.entries(localeResources));

        const isFullLocale = locale.includes("-");

        for (const [enKey, enValue] of enResourcesMap) {
            const enFullKey = `${parent === undefined ? "" : `${parent}.`}${enKey}`;

            const localeValue = localeResourcesMap.get(enKey);

            if (localeValue !== undefined) {
                const enValueType = typeof enValue;
                const localeValueType = typeof localeValue;

                if (localeValueType !== enValueType) {
                    throw new Error(`Mismatched value type ${localeValueType} for key ${enFullKey} in ${locale} resources (expected ${enValueType})`);
                }

                if (enValueType === "string") {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Value is known to be string.
                    const enParameterNames = AlphaPublisher.#parseParameterNames(enValue as unknown as string);

                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Value is known to be string.
                    const localeParameterNames = AlphaPublisher.#parseParameterNames(localeValue as unknown as string);

                    for (const enParameterName of enParameterNames) {
                        if (!localeParameterNames.includes(enParameterName)) {
                            throw new Error(`Missing parameter ${enParameterName} for key ${enFullKey} in ${locale} resources`);
                        }
                    }

                    for (const localeParameterName of localeParameterNames) {
                        if (!enParameterNames.includes(localeParameterName)) {
                            throw new Error(`Extraneous parameter ${localeParameterName} for key ${enFullKey} in ${locale} resources`);
                        }
                    }
                } else if (enValueType === "object") {
                    AlphaPublisher.#assertValidResources(enValue, locale, localeValue, `${parent === undefined ? "" : `${parent}.`}${enKey}`);
                }
            // Full locale falls back to language so ignore if missing.
            } else if (!isFullLocale) {
                throw new Error(`Missing key ${enFullKey} in ${locale} resources`);
            }
        }

        for (const [localeKey] of localeResourcesMap) {
            if (!enResourcesMap.has(localeKey)) {
                throw new Error(`Extraneous key ${parent === undefined ? "" : `${parent}.`}${localeKey} in ${locale} resources`);
            }
        }
    }

    /**
     * @inheritDoc
     */
    protected override async publish(): Promise<void> {
        const repositoryPublishState = this.repositoryPublishState;
        const packageConfiguration = repositoryPublishState.packageConfiguration;

        // Check for external updates, even if there are no changes, if working on the latest version.
        if (repositoryPublishState.repository.workingVersion === this.latestVersion) {
            for (const currentDependencies of [packageConfiguration.devDependencies, packageConfiguration.dependencies]) {
                if (currentDependencies !== undefined) {
                    for (const [dependencyPackageName, version] of Object.entries(currentDependencies)) {
                        // Ignore organization dependencies.
                        if (this.dependencyRepositoryName(dependencyPackageName) === null && version.startsWith("^")) {
                            const [latestVersion] = this.run(RunOptions.RunAlways, true, "npm", "view", dependencyPackageName, "version");

                            if (latestVersion !== version.substring(1)) {
                                this.logger.info(`Dependency ${dependencyPackageName}@${version} ${!this.#updateAll ? "pending update" : "updating"} to version ${latestVersion}.`);

                                if (this.#updateAll) {
                                    currentDependencies[dependencyPackageName] = `^${latestVersion}`;

                                    repositoryPublishState.savePackageConfigurationPending = true;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (repositoryPublishState.savePackageConfigurationPending) {
            this.savePackageConfiguration();
        }

        // Nothing to do if there are no changes and dependencies haven't been updated.
        if (this.anyChanges(repositoryPublishState.phaseDateTime, true) || repositoryPublishState.anyDependenciesUpdated) {
            const switchToAlpha = repositoryPublishState.preReleaseIdentifier !== "alpha";

            if (switchToAlpha) {
                // Use specified registry for organization until no longer in alpha mode.
                this.run(RunOptions.SkipOnDryRun, false, "npm", "config", "set", this.atOrganizationRegistry, "--location", "project");

                this.updatePackageVersion(undefined, undefined, repositoryPublishState.patchVersion + 1, "alpha");
            }

            // Update the package lock configuration to pick up any changes prior to this point.
            this.updatePackageLockConfiguration();

            // Run lint if present.
            this.run(RunOptions.SkipOnDryRun, false, "npm", "run", "lint", "--if-present");

            const localePath = path.resolve("src/locale");

            // Check for localization.
            if (fs.existsSync(localePath) && fs.statSync(localePath).isDirectory()) {
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
                    const enResources = localeResourcesMap.get("en");

                    if (enResources === undefined) {
                        throw new Error("English resources file not found");
                    }

                    for (const [locale, resources] of localeResourcesMap.entries()) {
                        if (locale !== "en") {
                            AlphaPublisher.#assertValidResources(enResources, locale, resources);
                        }
                    }
                }
            }

            // Run alpha build.
            this.run(RunOptions.SkipOnDryRun, false, "npm", "run", "build:alpha");

            // Run test if present.
            this.run(RunOptions.SkipOnDryRun, false, "npm", "run", "test", "--if-present");

            // Nothing further required if this repository is not a dependency of others.
            if (repositoryPublishState.repository.dependencyType === "external" || repositoryPublishState.repository.dependencyType === "internal") {
                // Package version is transient.
                const version = this.updatePackageVersion(undefined, undefined, undefined, `alpha.${new Date().toISOString().replaceAll(/\D/ug, "").substring(0, 12)}`);

                this.updatePhaseState({
                    version
                });

                try {
                    // Publish to development NPM registry.
                    this.run(RunOptions.ParameterizeOnDryRun, false, "npm", "publish", "--tag", "alpha");

                    // Unpublish all prior alpha versions.
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Output is a JSON array.
                    for (const priorVersion of JSON.parse(this.run(RunOptions.RunAlways, true, "npm", "view", packageConfiguration.name, "versions", "--json").join("\n")) as string[]) {
                        if (/^\d+.\d+.\d+-alpha.\d+$/u.test(priorVersion) && priorVersion !== version) {
                            this.run(RunOptions.ParameterizeOnDryRun, false, "npm", "unpublish", `${packageConfiguration.name}@${priorVersion}`);
                        }
                    }
                } finally {
                    // Restore package version without date/time stamp.
                    this.updatePackageVersion(undefined, undefined, undefined, "alpha");
                }
            }

            this.updatePhaseState({
                dateTime: new Date()
            });
        }
    }
}

// Detailed syntax checking not required as this is an internal tool.
const publisher = new AlphaPublisher(process.argv.includes("--update-all"), process.argv.includes("--dry-run"));

publisher.publishAll().catch((e: unknown) => {
    publisher.logger.error(e);
    process.exit(1);
});
