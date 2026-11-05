import * as process from "node:process";
import { Publisher, RunOptions } from "./publisher.js";

/**
 * Clean install.
 */
class CleanInstall extends Publisher<undefined> {
    /**
     * Constructor.
     *
     * @param isDryRun
     * If true, output what would be produced rather than producing it.
     */
    constructor(isDryRun: boolean) {
        super(undefined, isDryRun);
    }

    /**
     * @inheritDoc
     */
    protected override getDependencyVersion(): string {
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
        const repository = this.repository;

        // Configure organization registry based on pre-release identifier.
        if (repository.parsedVersion.preReleaseIdentifier === "alpha") {
            this.setOrganizationAlphaRegistry();
        } else {
            this.unsetOrganizationAlphaRegistry();
        }

        if (repository.name !== "publisher") {
            this.run(RunOptions.SkipOnDryRun, false, false, "npm", "clean-install");
        }
    }
}

// Detailed syntax checking not required as this is an internal tool.
const publisher = new CleanInstall(process.argv.includes("--dry-run"));

publisher.publishAll().catch((e: unknown) => {
    publisher.logger.error("Publisher failed", e);
    process.exit(1);
});
