import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const db = new aws.rds.Instance("shop-db", { engine: "postgres", instanceClass: "db.t4g.micro", allocatedStorage: 20 });
const bucket = new aws.s3.BucketV2("shop-assets");
const svc = new awsx.ecs.FargateService("shop-web", {});
const fn = new aws.lambda.Function("thumbs", {});
