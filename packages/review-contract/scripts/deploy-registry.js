import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";

// Deploys ONLY the CampaignRegistry to the configured network. The roster
// contracts (PeerReviewQuorum / ProofAnchor) are deployed separately and stay
// untouched.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = JSON.parse(readFileSync(join(PACKAGE_ROOT, "src", "campaign-registry-abi.json"), "utf8"));

function fail(message) {
  process.stderr.write(`Deploy failed: ${message}\n`);
  process.exit(1);
}

const options = {
  rpcUrl: process.env.DEPLOY_RPC_URL ?? null,
  privateKey: process.env.DEPLOY_PRIVATE_KEY ?? null,
};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 2) {
  if (argv[index] === "--rpc-url") options.rpcUrl = argv[index + 1];
  else if (argv[index] === "--private-key") options.privateKey = argv[index + 1];
  else fail(`Unknown argument ${argv[index]}`);
}
if (!options.rpcUrl || !options.privateKey) fail("Missing --rpc-url or --private-key");

const provider = new JsonRpcProvider(options.rpcUrl);
const network = await provider.getNetwork();
process.stdout.write(`Connected to chain ${network.chainId}\n`);
if (network.chainId !== 11155111n) fail("Expected Sepolia (chain 11155111)");

const deployer = new Wallet(options.privateKey, provider);
const balance = await provider.getBalance(deployer.address);
process.stdout.write(`Deployer ${deployer.address} balance ${Number(balance) / 1e18} ETH\n`);
if (balance === 0n) fail("Deployer has no gas funds");

const registry = await new ContractFactory(ARTIFACT.abi, ARTIFACT.bytecode, deployer).deploy();
process.stdout.write(`CampaignRegistry deploying: ${registry.deploymentTransaction()?.hash}\n`);
await registry.waitForDeployment();
const address = await registry.getAddress();
process.stdout.write("\nDeployment complete. Add to backend/.env:\n\n");
process.stdout.write(`CAMPAIGN_REGISTRY_ADDRESS=${address.toLowerCase()}\n`);
process.exitCode = 0;
