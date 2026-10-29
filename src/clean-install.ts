import * as process from "node:process";
import { Publisher, RunOptions } from "./publisher.js";

/**
 * Clean install.
 */
class CleanInstall extends Publisher<undefined> {
    /**
     * Constructor.
     *
     * @param dryRun
     * If true, output what would be run rather than running it.
     */
    constructor(dryRun: boolean) {
        super(undefined, dryRun);
    }

    /**
     * @inheritDoc
     */
    protected override dependencyVersionFor(): string {
        return "";
    }

    /**
     * @inheritDoc
     */
    protected override isValidRepositoryChange(): boolean {
        return false;
    }

    /**
     * @inheritDoc
     */
    protected override isValidBranch(): boolean {
        return true;
    }

    /**
     * @inheritDoc
     */
    protected override publish(): void {
        const repositoryPublishState = this.repositoryPublishState;

        // Configure project registry based on pre-release identifier.
        this.run(RunOptions.SkipOnDryRun, false, false, "npm", "config", repositoryPublishState.preReleaseIdentifier === "alpha" ? "set" : "delete", this.atOrganizationRegistry, "--location", "project");

        if (repositoryPublishState.repositoryName !== "publisher") {
            this.run(RunOptions.SkipOnDryRun, false, false, "npm", "clean-install");
        }
    }
}

// Detailed syntax checking not required as this is an internal tool.
const publisher = new CleanInstall(process.argv.includes("--dry-run"));

publisher.publishAll().catch((e: unknown) => {
    publisher.logger.error(e);
    process.exit(1);
});
