#!/usr/bin/env node
import { loadRuntimeConfig, assessReadiness } from '../src/config/requirements.mjs';

const config = loadRuntimeConfig(process.env);
const assessment = assessReadiness(config);
console.log(JSON.stringify({
  environment: config.nodeEnv,
  workflowWrites: config.enableWorkflowWrites,
  notificationProvider: config.notificationProvider,
  paymentProvider: config.paymentProvider,
  ...assessment
}, null, 2));
if (!assessment.ready) process.exitCode = 1;
