import { defineConfig } from 'hardhat/config'

export default defineConfig({
  solidity: {
    version: '0.8.28',
    settings: { optimizer: { enabled: true, runs: 300 } },
  },
  networks: {
    hardhatMainnet: { type: 'edr-simulated', chainType: 'l1', chainId: 31337 },
    localhost: { type: 'http', chainType: 'l1', url: 'http://127.0.0.1:8545' },
  },
})
