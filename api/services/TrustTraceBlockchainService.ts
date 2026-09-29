import { Contract, FetchRequest, getAddress, isAddress, JsonRpcProvider, Wallet } from 'ethers'
import type { JsonRpcSigner } from 'ethers'

const registryAbi = [
  'function anchor(bytes32 eventHash) external returns (uint256 timestamp)',
  'function isAnchored(bytes32 eventHash) external view returns (bool)',
  'function getAnchor(bytes32 eventHash) external view returns (bool exists, uint256 timestamp, uint256 blockNumber, address submitter)',
  'event HashAnchored(bytes32 indexed eventHash, uint256 timestamp, uint256 blockNumber, address indexed submitter)',
]

export type AnchorReceipt = {
  transactionHash: string
  blockNumber: bigint
  contractAddress: string
  chainId: string
  networkName: string
}

export type BlockchainFailureCode = 'BLOCKCHAIN_NOT_CONFIGURED' | 'BLOCKCHAIN_SIGNER_NOT_CONFIGURED' | 'BLOCKCHAIN_RPC_UNAVAILABLE' | 'BLOCKCHAIN_ANCHOR_FAILED' | 'BLOCKCHAIN_PROOF_INCONSISTENT'
export type OnChainProof = { exists: boolean; timestamp: bigint | null; blockNumber: bigint | null; submitter: string | null; transactionHash: string | null }

export class BlockchainServiceError extends Error {
  constructor(public readonly code: BlockchainFailureCode) {
    super(code)
    this.name = 'BlockchainServiceError'
  }
}

export class TrustTraceBlockchainService {
  private readonly provider?: JsonRpcProvider
  private readonly contractAddress?: string
  private readonly privateKey?: string

  constructor(config = {
    rpcUrl: process.env.BLOCKCHAIN_RPC_URL,
    privateKey: process.env.BLOCKCHAIN_PRIVATE_KEY,
    contractAddress: process.env.TRUSTTRACE_REGISTRY_ADDRESS,
  }) {
    if (config.rpcUrl) {
      const request = new FetchRequest(config.rpcUrl)
      request.timeout = 5_000
      this.provider = new JsonRpcProvider(request)
    }
    if (config.contractAddress && isAddress(config.contractAddress)) this.contractAddress = getAddress(config.contractAddress)
    if (config.privateKey) this.privateKey = config.privateKey
  }

  get isConfigured() {
    return Boolean(this.provider && this.contractAddress)
  }

  async getStatus() {
    if (!this.isConfigured) return { configured: false, available: false, writeAvailable: false, contractAddress: null, chainId: null, networkName: null }
    try {
      const [network, blockNumber] = await Promise.all([this.provider!.getNetwork(), this.provider!.getBlockNumber()])
      const localSignerAvailable = network.chainId === 31337n
      return {
        configured: true,
        available: blockNumber >= 0,
        writeAvailable: Boolean(this.privateKey) || localSignerAvailable,
        contractAddress: this.contractAddress!,
        chainId: network.chainId.toString(),
        networkName: localSignerAvailable ? 'Hardhat Local' : `Chain ${network.chainId}`,
      }
    } catch {
      return { configured: true, available: false, writeAvailable: Boolean(this.privateKey), contractAddress: this.contractAddress!, chainId: null, networkName: null }
    }
  }

  async anchor(eventHash: string): Promise<AnchorReceipt> {
    this.assertHash(eventHash)
    if (!this.isConfigured) throw new BlockchainServiceError('BLOCKCHAIN_NOT_CONFIGURED')
    const provider = this.provider!
    let network
    try {
      network = await provider.getNetwork()
    } catch {
      throw new BlockchainServiceError('BLOCKCHAIN_RPC_UNAVAILABLE')
    }

    let signer: Wallet | JsonRpcSigner
    try {
      if (this.privateKey) signer = new Wallet(this.privateKey, provider)
      else if (network.chainId === 31337n) signer = await provider.getSigner(0)
      else throw new BlockchainServiceError('BLOCKCHAIN_SIGNER_NOT_CONFIGURED')
    } catch (error) {
      if (error instanceof BlockchainServiceError) throw error
      throw new BlockchainServiceError('BLOCKCHAIN_SIGNER_NOT_CONFIGURED')
    }

    const readContract = new Contract(this.contractAddress!, registryAbi, provider)
    const proof = await this.getProof(eventHash, readContract).catch(() => { throw new BlockchainServiceError('BLOCKCHAIN_RPC_UNAVAILABLE') })
    if (proof.exists) {
      if (!proof.transactionHash || proof.blockNumber === null) throw new BlockchainServiceError('BLOCKCHAIN_PROOF_INCONSISTENT')
      const networkStatus = await this.getStatus()
      return { transactionHash: proof.transactionHash, blockNumber: proof.blockNumber, contractAddress: this.contractAddress!, chainId: network.chainId.toString(), networkName: networkStatus.networkName ?? `Chain ${network.chainId}` }
    }

    try {
      const writeContract = new Contract(this.contractAddress!, registryAbi, signer)
      const transaction = await writeContract.anchor(`0x${eventHash}`)
      const receipt = await transaction.wait()
      if (!receipt || receipt.status !== 1) throw new Error('Transaction failed')
      const onChainProof = await this.getProof(eventHash, readContract)
      if (!onChainProof.exists || onChainProof.blockNumber === null) throw new BlockchainServiceError('BLOCKCHAIN_PROOF_INCONSISTENT')
      return {
        transactionHash: receipt.hash,
        blockNumber: BigInt(receipt.blockNumber),
        contractAddress: this.contractAddress!,
        chainId: network.chainId.toString(),
        networkName: network.chainId === 31337n ? 'Hardhat Local' : `Chain ${network.chainId}`,
      }
    } catch (error) {
      if (error instanceof BlockchainServiceError) throw error
      throw new BlockchainServiceError('BLOCKCHAIN_ANCHOR_FAILED')
    }
  }

  async verify(eventHash: string): Promise<{ status: 'ANCHORED' | 'NOT_ANCHORED' | 'UNAVAILABLE' | 'NOT_CONFIGURED'; proof?: OnChainProof }> {
    this.assertHash(eventHash)
    if (!this.isConfigured) return { status: 'NOT_CONFIGURED' }
    try {
      const proof = await this.getProof(eventHash, new Contract(this.contractAddress!, registryAbi, this.provider!))
      return proof.exists ? { status: 'ANCHORED', proof } : { status: 'NOT_ANCHORED', proof }
    } catch {
      return { status: 'UNAVAILABLE' }
    }
  }

  private async getProof(eventHash: string, contract: Contract): Promise<OnChainProof> {
    const [exists, timestamp, blockNumber, submitter] = await contract.getAnchor(`0x${eventHash}`) as [boolean, bigint, bigint, string]
    if (!exists) return { exists: false, timestamp: null, blockNumber: null, submitter: null, transactionHash: null }
    const block = Number(blockNumber)
    if (!Number.isSafeInteger(block)) throw new BlockchainServiceError('BLOCKCHAIN_PROOF_INCONSISTENT')
    const filter = contract.filters.HashAnchored(`0x${eventHash}`)
    const logs = await contract.queryFilter(filter, block, block)
    const log = logs.find((entry) => entry.blockNumber === block)
    if (!log) throw new BlockchainServiceError('BLOCKCHAIN_PROOF_INCONSISTENT')
    return { exists: true, timestamp, blockNumber, submitter, transactionHash: log.transactionHash }
  }

  private assertHash(eventHash: string) {
    if (!/^[a-f0-9]{64}$/i.test(eventHash)) throw new BlockchainServiceError('BLOCKCHAIN_PROOF_INCONSISTENT')
  }
}
