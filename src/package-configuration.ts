/**
 * Configuration path for package.json.
 */
export const PACKAGE_CONFIGURATION_PATH = "package.json";

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
