import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { JsonRpcProvider } from 'ethers'

type ContractArtifact = { bytecode: string }

async function deployRegistry() {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL ?? 'http://127.0.0.1:8545'
  const provider = new JsonRpcProvider(rpcUrl)
  try {
    const network = await provider.getNetwork()
    if (network.chainId !== 31337n) throw new Error('The deployment helper only targets the local Hardhat chain (31337)')
    const accounts = await provider.send('eth_accounts', []) as string[]
    const deployer = accounts[0]
    if (!deployer) throw new Error('The local Hardhat node did not expose an unlocked development account')
    const artifact = JSON.parse(await readFile(resolve('artifacts/contracts/TrustTraceRegistry.sol/TrustTraceRegistry.json'), 'utf8')) as ContractArtifact
    const transactionHash = await provider.send('eth_sendTransaction', [{ from: deployer, data: artifact.bytecode }]) as string
    const receipt = await provider.waitForTransaction(transactionHash, 1, 30_000)
    if (!receipt?.contractAddress || receipt.status !== 1) throw new Error('The local registry deployment transaction failed')
    console.log(JSON.stringify({ contractAddress: receipt.contractAddress, chainId: network.chainId.toString(), transactionHash: receipt.hash }, null, 2))
  } finally {
    provider.destroy()
  }
}

void deployRegistry().catch(() => {
  console.error('Local registry deployment failed. Confirm the Hardhat node is running and the contract is compiled.')
  process.exitCode = 1
})