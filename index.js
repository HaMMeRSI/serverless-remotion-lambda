const path = require('path');

const { deployFunction, deploySite, getOrCreateBucket, deleteFunction, getFunctions } = require('@remotion/lambda');
const { VERSION } = require('remotion');

const resources = require('./iam');

const SITE_ID = `remotion-render-app-${VERSION}`;

class RemotionPlugin {
    constructor(serverless, options) {
        this.pOptions = {
            lambda: {
                architecture: 'arm64',
                createCloudWatchLogGroup: true,
                memorySizeInMb: 2048,
                timeoutInSeconds: 240,
            },
            timeoutInSeconds: 20,
            entryPoint: null,
            deployStage: null,
            deployRegions: [],
            ...serverless.service.custom.remotion,
        };

        if (options.stage !== this.pOptions.deployStage) {
            this.serverless.cli.log('Not deploying remotion because stage does not match');
            return;
        }

        if (!this.pOptions.entryPoint) {
            throw new Error('No entryPoint specified in remotion-lambda plugin');
        }
        if (!this.pOptions.deployRegions.length) {
            throw new Error('No deployRegions specified in remotion-lambda plugin');
        }
        if (!this.pOptions.deployStage) {
            throw new Error('No deployStage specified in remotion-lambda plugin');
        }

        this.serverless = serverless;
        this.provider = this.serverless.getProvider('aws');

        this.hooks = {
            initialize: () => this.init(),
            'after:deploy:deploy': () => this.afterDeploy(),
            'remove:remove': () => this.remove(),
        };
    }

    init() {
        this.serverless.service.resources.Resources = {
            ...this.serverless.service.resources.Resources,
            ...resources,
        };

        this.serverless.cli.log('Initialized Remotion plugin, added resources');
    }

    remove() {
        return this.removeLambda();
    }

    async afterDeploy() {
        const stage = this.provider.getStage();
        const region = this.provider.getRegion();
        const UserName = resources.RemotionUser.Properties.UserName;

        this.serverless.cli.log('Deploying Remotion plugin');

        const oldKeys = await this.provider.request('IAM', 'listAccessKeys', { UserName }, stage, region);
        const deletePromises = oldKeys['AccessKeyMetadata'].map(
            async key =>
                await this.provider.request(
                    'IAM',
                    'deleteAccessKey',
                    { UserName, AccessKeyId: key.AccessKeyId },
                    stage,
                    region
                )
        );

        await Promise.all(deletePromises);

        const {
            AccessKey: { AccessKeyId, SecretAccessKey },
        } = await this.provider.request('IAM', 'createAccessKey', { UserName }, stage, region);

        process.env.REMOTION_AWS_ACCESS_KEY_ID = AccessKeyId;
        process.env.REMOTION_AWS_SECRET_ACCESS_KEY = SecretAccessKey;

        const time = Date.now();
        let redo = false;
        let lastError = null;

        do {
            if ((Date.now() - time) / 1000 > this.pOptions.timeoutInSeconds) {
                this.serverless.cli.log('Deploying remotion timed out - no function deployed');
                throw lastError;
            }

            try {
                redo = false;
                await this.deployLambda();
            } catch (e) {
                if (e.Code !== 'InvalidClientTokenId') {
                    throw e;
                }

                redo = true;
                lastError = e;
                await new Promise(resolve => setTimeout(resolve, 2500));
            }
        } while (redo);

        await this.provider.request('IAM', 'deleteAccessKey', { UserName, AccessKeyId: AccessKeyId }, stage, region);

        this.serverless.cli.log(`Deployed remotion site in ${(Date.now() - time) / 1000} seconds`);
    }

    async deployLambda() {
        const entryPoint = path.join(process.cwd(), this.pOptions.entryPoint);

        for (const region of this.pOptions.deployRegions) {
            const { functionName, alreadyExisted } = await deployFunction({
                architecture: this.pOptions.lambda.architecture,
                createCloudWatchLogGroup: this.pOptions.lambda.createCloudWatchLogGroup,
                memorySizeInMb: this.pOptions.lambda.memorySizeInMb,
                timeoutInSeconds: this.pOptions.lambda.timeoutInSeconds,
                region,
            });

            this.serverless.cli.log(
                `${alreadyExisted ? 'Ensured' : 'Deployed'} function "${functionName}" to ${region}`
            );

            const { bucketName } = await getOrCreateBucket({ region });

            this.serverless.cli.log(`entryPoint ${entryPoint}`);

            const { serveUrl: _ } = await deploySite({
                siteName: SITE_ID,
                bucketName,
                entryPoint,
                region,
            });
        }
    }

    async removeLambda() {
        for (const region of this.pOptions.deployRegions) {
            const functions = await getFunctions({
                region,
                compatibleOnly: false,
            });

            for (const fn of functions) {
                this.serverless.cli.log(`Deleting ${fn.functionName}`);

                await deleteFunction({
                    region,
                    functionName: fn.functionName,
                });

                this.serverless.cli.log(`Deleted ${fn.functionName}`);
            }
        }
    }
}

module.exports = RemotionPlugin;
