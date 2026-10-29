import { getLogger } from "@aidc-toolkit/core";
import { spawnSync } from "node:child_process";
import * as process from "node:process";
import { loadConfiguration } from "./configuration.js";

const configuration = loadConfiguration();

const logger = getLogger(configuration.logLevel);

for (const [repositoryName, repository] of Object.entries(configuration.repositories)) {
    logger.info(`Repository ${repositoryName}...`);

    // All repository directories are expected to be children of the parent of this repository.
    process.chdir(`../${repository.directory ?? repositoryName}`);

    if (repositoryName !== "publisher") {
        const spawnResult = spawnSync("npm", ["clean-install"]);

        if (spawnResult.error !== undefined) {
            throw spawnResult.error;
        }

        if (spawnResult.status === null) {
            throw new Error(`Terminated by signal ${spawnResult.signal}`);
        }

        if (spawnResult.status !== 0) {
            throw new Error(`Failed with status ${spawnResult.status}`);
        }
    }
}
