const path = require('path');

const { deployFunction, deploySite, getOrCreateBucket, deleteFunction, getFunctions } = require('@remotion/lambda');
const { VERSION } = require('remotion');

const resources = require('./iam');

class RemotionPlugin {
    constructor(serverless, options) {
        this.pOptions = {
            deployTimeoutInSeconds: 30,
            entryPoint: null,
            deployStage: null,
            deployRegions: [],
            bucketName: null,
            siteId: 'remotion-render-app',
            ...serverless.service.custom.remotion,
            lambda: {
                architecture: 'arm64',
                createCloudWatchLogGroup: true,
                memorySizeInMb: 2048,
                timeoutInSeconds: 240,
                ...serverless.service.custom.remotion.lambda,
            },
        };

        if (!this.pOptions.entryPoint) {
            throw new Error('No entryPoint specified in remotion-lambda plugin');
        } else if (!this.pOptions.deployRegions.length) {
            throw new Error('No deployRegions specified in remotion-lambda plugin');
        } else if (!this.pOptions.deployStage) {
            throw new Error('No deployStage specified in remotion-lambda plugin');
        }

        this.serverless = serverless;
        this.provider = this.serverless.getProvider('aws');

        if (options.stage !== this.pOptions.deployStage) {
            this.hooks = {
                'after:deploy:deploy': () => this.deploySite(),
            };
        } else {
            this.hooks = {
                initialize: () => this.init(),
                'after:deploy:deploy': () => this.afterDeploy(),
                'remove:remove': () => this.remove(),
            };
        }
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

        this.serverless.cli.log('Deploying remotion lambda');
        await this.deployLambda();
        this.serverless.cli.log('Deploying remotion site');
        await this.deploySite();
        await this.provider.request('IAM', 'deleteAccessKey', { UserName, AccessKeyId: AccessKeyId }, stage, region);

        this.serverless.cli.log(`Deployed remotion site`);
    }

    async deployLambda() {
        const time = Date.now();
        let redo = false;
        let lastError = null;

        do {
            if ((Date.now() - time) / 1000 > this.pOptions.deployTimeoutInSeconds) {
                this.serverless.cli.log('Deploying remotion timed out - no function deployed');
                throw lastError;
            }

            try {
                redo = false;
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
                }
            } catch (e) {
                if (e.Code !== 'InvalidClientTokenId' && e.name !== 'UnrecognizedClientException') {
                    throw e;
                }

                redo = true;
                lastError = e;
                await new Promise(resolve => setTimeout(resolve, 2500));
            }
        } while (redo);
    }

    async deploySite() {
        const entryPoint = path.join(process.cwd(), this.pOptions.entryPoint);
        for (const region of this.pOptions.deployRegions) {
            let bucketName = this.pOptions.bucketName;
            if (!bucketName) {
                if (options.stage !== this.pOptions.deployStage) {
                    return;
                }

                const result = await getOrCreateBucket({ region });
                bucketName = result.bucketName;
            } else if (typeof bucketName === 'object') {
                const ref = bucketName['Ref'];
                bucketName = this.serverless.service.resources.Resources[ref].Properties.BucketName;
            }

            this.serverless.cli.log(`entryPoint ${entryPoint}`);

            const { serveUrl: _ } = await deploySite({
                siteName: `${this.pOptions.siteId}-${VERSION}`,
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
