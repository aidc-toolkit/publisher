import * as fs from "node:fs";
import * as path from "node:path";
import type { Repository } from "./configuration";
import { logger } from "./logger";
import { PACKAGE_CONFIGURATION_PATH, PACKAGE_LOCK_CONFIGURATION_PATH, Publish } from "./publish";

const BACKUP_PACKAGE_CONFIGURATION_PATH = ".package.json";

/**
 * Publish alpha versions.
 */
class PublishAlpha extends Publish {
    /**
     * If true, update all dependencies automatically.
     */
    private readonly _updateAll: boolean;

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

        this._updateAll = updateAll;
    }

    /**
     * @inheritDoc
     */
    protected dependencyVersionFor(): string {
        // Dependency version is always "alpha".
        return "alpha";
    }

    /**
     * @inheritDoc
     */
    protected getPhaseDateTime(repository: Repository, phaseDateTime: Date | undefined): Date | undefined {
        // If beta or production has been published since the last alpha, use that instead.
        return this.latestDateTime(phaseDateTime, repository.phaseStates.beta?.dateTime, repository.phaseStates.production?.dateTime);
    }

    /**
     * @inheritDoc
     */
    protected isValidBranch(): boolean {
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
    private static parseParameterNames(s: string): string[] {
        const parameterRegExp = /\{\{.+?}}/g;

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
    private static assertValidResources(enResources: object, locale: string, localeResources: object, parent?: string): void {
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
                    const enParameterNames = PublishAlpha.parseParameterNames(enValue as unknown as string);

                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Value is known to be string.
                    const localeParameterNames = PublishAlpha.parseParameterNames(localeValue as unknown as string);

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
                    PublishAlpha.assertValidResources(enValue, locale, localeValue, `${parent === undefined ? "" : `${parent}.`}${enKey}`);
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
    protected async publish(): Promise<void> {
        let anyExternalUpdates = false;

        const repositoryState = this.repositoryState;
        const packageConfiguration = repositoryState.packageConfiguration;

        // Check for external updates, even if there are no changes.
        for (const currentDependencies of [packageConfiguration.devDependencies, packageConfiguration.dependencies]) {
            if (currentDependencies !== undefined) {
                for (const [dependencyPackageName, version] of Object.entries(currentDependencies)) {
                    // Ignore organization dependencies.
                    if (this.dependencyRepositoryName(dependencyPackageName) === null && version.startsWith("^")) {
                        const [latestVersion] = this.run(true, true, "npm", "view", dependencyPackageName, "version");

                        if (latestVersion !== version.substring(1)) {
                            logger.info(`Dependency ${dependencyPackageName}@${version} ${!this._updateAll ? "pending update" : "updating"} to version ${latestVersion}.`);

                            if (this._updateAll) {
                                currentDependencies[dependencyPackageName] = `^${latestVersion}`;

                                anyExternalUpdates = true;
                            }
                        }
                    }
                }
            }
        }

        if (anyExternalUpdates) {
            // Save the dependency updates; this will be detected by call to anyChanges().
            this.savePackageConfiguration();
        }

        if (this._updateAll) {
            logger.debug("Updating all dependencies");

            // Running this even if there are no dependency updates will update dependencies of dependencies.
            this.run(false, false, "npm", "update");
        }

        // Nothing to do if there are no changes and dependencies haven't been updated.
        if (this.anyChanges(repositoryState.phaseDateTime, true) || repositoryState.anyDependenciesUpdated) {
            const switchToAlpha = repositoryState.preReleaseIdentifier !== "alpha";

            if (switchToAlpha) {
                // Previous publication was beta or production.
                this.updatePackageVersion(undefined, undefined, repositoryState.patchVersion + 1, "alpha");

                this.commitUpdatedPackageVersion(PACKAGE_CONFIGURATION_PATH);

                // Use specified registry for organization until no longer in alpha mode.
                this.run(false, false, "npm", "config", "set", this.atOrganizationRegistry, "--location", "project");
            }

            if (repositoryState.anyDependenciesUpdated && (switchToAlpha || !this._updateAll)) {
                this.updateOrganizationDependencies();
            }

            // Run lint if present.
            this.run(false, false, "npm", "run", "lint", "--if-present");

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
                            PublishAlpha.assertValidResources(enResources, locale, resources);
                        }
                    }
                }
            }

            // Run development build if present.
            this.run(false, false, "npm", "run", "build:dev", "--if-present");

            // Run test if present.
            this.run(false, false, "npm", "run", "test", "--if-present");

            const now = new Date();
            // Nothing further required if this repository is not a dependency of others.
            if (repositoryState.repository.dependencyType !== "none") {
                if (!this.dryRun) {
                    // Backup the package configuration file.
                    fs.renameSync(PACKAGE_CONFIGURATION_PATH, BACKUP_PACKAGE_CONFIGURATION_PATH);
                }

                try {
                    // Package version is transient.
                    this.updatePackageVersion(undefined, undefined, undefined, `alpha.${now.toISOString().replaceAll(/\D/g, "").substring(0, 12)}`);

                    // Publish to development NPM registry.
                    this.run(false, false, "npm", "publish", "--tag", "alpha");

                    // Unpublish all prior alpha versions.
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Output is a JSON array.
                    for (const version of JSON.parse(this.run(true, true, "npm", "view", packageConfiguration.name, "versions", "--json").join("\n")) as string[]) {
                        if (/^\d+.\d+.\d+-alpha.\d+$/.test(version) && version !== packageConfiguration.version) {
                            this.run(false, false, "npm", "unpublish", `${packageConfiguration.name}@${version}`);
                        }
                    }
                } finally {
                    if (!this.dryRun) {
                        // Restore the package configuration file.
                        fs.rmSync(PACKAGE_CONFIGURATION_PATH);
                        fs.renameSync(BACKUP_PACKAGE_CONFIGURATION_PATH, PACKAGE_CONFIGURATION_PATH);
                    }
                }
            }

            this.commitUpdatedPackageVersion(PACKAGE_LOCK_CONFIGURATION_PATH);

            this.updatePhaseState({
                dateTime: now
            });
        }
    }
}

// Detailed syntax checking not required as this is an internal tool.
await new PublishAlpha(process.argv.includes("--update-all"), process.argv.includes("--dry-run")).publishAll().catch((e: unknown) => {
    logger.error(e);
});
