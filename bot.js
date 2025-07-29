const fs = require('fs');
const axios = require('axios');
const nacl = require('tweetnacl');
const Base58 = require('base-58');

// ASCII Art Banner
const FOGO_ASCII = `
\x1b[36m\x1b[1m
███████╗ ██████╗  ██████╗  ██████╗     ███████╗██╗    ██╗ █████╗ ██████╗
██╔════╝██╔═══██╗██╔════╝ ██╔═══██╗    ██╔════╝██║    ██║██╔══██╗██╔══██╗
█████╗  ██║   ██║██║  ███╗██║   ██║    ███████╗██║ █╗ ██║███████║██████╔╝
██╔══╝  ██║   ██║██║   ██║██║   ██║    ╚════██║██║███╗██║██╔══██║██╔═══╝
██║     ╚██████╔╝╚██████╔╝╚██████╔╝    ███████║╚███╔███╔╝██║  ██║██║
╚═╝      ╚═════╝  ╚═════╝  ╚═════╝     ╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝
                        by@AUTODROP CENTRAL
\x1b[0m
`;

// Load Configuration
function loadConfig() {
    try {
        const configData = fs.readFileSync('config.json', 'utf8');
        return JSON.parse(configData);
    } catch (error) {
        console.log('[ERROR] Failed to load config.json');
        process.exit(1);
    }
}

// Load Private Keys
function loadPrivateKeys() {
    try {
        const data = fs.readFileSync('privatekey.txt', 'utf8');
        const keys = data.split('\n').map(key => key.trim()).filter(key => key);
        if (keys.length === 0) {
            console.log('[ERROR] No private keys found in privatekey.txt');
            process.exit(1);
        }
        return keys;
    } catch (error) {
        console.log('[ERROR] Failed to load privatekey.txt');
        process.exit(1);
    }
}

// Logger Class
class Logger {
    static colors = {
        reset: "\x1b[0m",
        cyan: "\x1b[36m",
        green: "\x1b[32m",
        yellow: "\x1b[33m",
        red: "\x1b[31m",
        white: "\x1b[37m"
    };

    static getTimestamp() {
        const now = new Date();
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const seconds = now.getSeconds().toString().padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    }

    static info(msg) {
        console.log(`${this.colors.cyan}[${this.getTimestamp()}][i] ${msg}${this.colors.reset}`);
    }

    static success(msg) {
        console.log(`${this.colors.green}[${this.getTimestamp()}][+] ${msg}${this.colors.reset}`);
    }

    static error(msg) {
        console.log(`${this.colors.red}[${this.getTimestamp()}][ERROR] ${msg}${this.colors.reset}`);
    }

    static warn(msg) {
        console.log(`${this.colors.yellow}[${this.getTimestamp()}][WARN] ${msg}${this.colors.reset}`);
    }

    static step(msg) {
        console.log(`${this.colors.white}[${this.getTimestamp()}][>] ${msg}${this.colors.reset}`);
    }

    static banner() {
        console.clear();
        console.log(FOGO_ASCII);
        console.log(`${this.colors.cyan}================================================================${this.colors.reset}`);
    }
}

// HTTP Client
class ApiClient {
    constructor() {
        this.client = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });
    }

    async get(url, params = {}) {
        return this.client.get(url, { params });
    }

    async post(url, data = {}) {
        return this.client.post(url, data);
    }
}

// Wallet Manager
class WalletManager {
    static createWallets(privateKeys) {
        return privateKeys.map(pk => {
            try {
                const keyPair = nacl.sign.keyPair.fromSecretKey(Base58.decode(pk));
                return {
                    keyPair,
                    publicKey: Base58.encode(keyPair.publicKey),
                    address: Base58.encode(keyPair.publicKey).substring(0, 8) + "..."
                };
            } catch (e) {
                Logger.error(`Invalid private key format: ${pk.substring(0, 8)}...`);
                return null;
            }
        }).filter(Boolean);
    }
}

// Swap Engine
class SwapEngine {
    constructor(config) {
        this.config = config;
        this.api = new ApiClient();
    }

    async executeSwap(wallet, amount, direction) {
        const isToFUSD = direction === 'TO_FUSD';
        const fromToken = isToFUSD ? 'FOGO' : 'FUSD';
        const toToken = isToFUSD ? 'FUSD' : 'FOGO';

        Logger.info(`Performing ${fromToken} → ${toToken} swap`);

        try {
            // Get quote
            Logger.step("Fetching quote from DEX");
            const quote = await this.getQuote(amount, isToFUSD);
            Logger.success(`Estimated output: ${(quote.tokenMinOut / (isToFUSD ? 1e6 : 1e9)).toFixed(6)} ${toToken}`);

            // Create transaction
            Logger.step("Building transaction");
            const txData = await this.createTransaction(wallet, amount, quote, isToFUSD);

            // Sign transaction
            Logger.step("Signing with private key");
            const signedTx = this.signTransaction(txData, wallet);

            // Submit transaction
            Logger.step("Sending transaction to network");
            const txHash = await this.submitTransaction(signedTx);
            Logger.success(`TX Hash: ${txHash}`);

            // Confirm transaction
            Logger.step("Awaiting network confirmation...");
            const confirmed = await this.confirmTransaction(txHash);
            
            if (confirmed) {
                Logger.success(`Swap confirmed: ${fromToken} → ${toToken}`);
                return parseInt(quote.tokenMinOut);
            } else {
                Logger.error("Transaction confirmation failed");
                return 0;
            }

        } catch (error) {
            Logger.error(`Swap failed: ${error.message}`);
            return 0;
        }
    }

    async getQuote(amount, isToFUSD) {
        const params = {
            mintA: this.config.tokens.FOGO,
            mintB: this.config.tokens.FUSD,
            aForB: isToFUSD.toString(),
            isExactIn: "true",
            inputAmount: amount,
            feePayer: this.config.feePayer
        };

        const response = await this.api.get(`${this.config.apiUrl}/dex/quote`, params);
        return response.data.quote;
    }

    async createTransaction(wallet, amount, quote, isToFUSD) {
        const params = {
            mintA: this.config.tokens.FOGO,
            mintB: this.config.tokens.FUSD,
            aForB: isToFUSD.toString(),
            isExactIn: "true",
            inputAmount: amount,
            feePayer: this.config.feePayer,
            userAddress: wallet.publicKey,
            outputAmount: quote.tokenMinOut,
            poolAddress: quote.poolAddress,
            sessionAddress: wallet.publicKey
        };

        const response = await this.api.get(`${this.config.apiUrl}/dex/txs/swap`, params);
        return response.data.serializedTx;
    }

    signTransaction(serializedTx, wallet) {
        const rawTx = Buffer.from(serializedTx, 'base64');
        const numSignatures = rawTx[0];
        const messageToSign = rawTx.slice(1 + (numSignatures * 64));
        const signature = nacl.sign.detached(messageToSign, wallet.keyPair.secretKey);
        const signedTx = Buffer.from(rawTx);
        signedTx.set(signature, 1 + 64);
        return signedTx.toString('base64');
    }

    async submitTransaction(signedTx) {
        const response = await this.api.post(this.config.paymasterUrl, { transaction: signedTx });
        return response.data;
    }

    async confirmTransaction(txHash, timeout = 90000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            try {
                const response = await this.api.post(this.config.rpcUrl, {
                    jsonrpc: "2.0",
                    id: "1",
                    method: "getSignatureStatuses",
                    params: [[txHash], { searchTransactionHistory: true }]
                });

                const status = response.data.result?.value?.[0];
                if (status?.confirmationStatus === 'finalized' || status?.confirmationStatus === 'confirmed') {
                    return !status.err;
                }
                
                await this.delay(5000);
            } catch (error) {
                await this.delay(5000);
            }
        }
        return false;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Main Bot Class
class FogoBot {
    constructor() {
        this.config = loadConfig();
        this.privateKeys = loadPrivateKeys();
        this.wallets = WalletManager.createWallets(this.privateKeys);
        this.swapEngine = new SwapEngine(this.config);
    }

    async start() {
        Logger.banner();
        Logger.success(`${this.wallets.length} wallets detected and initialized`);
        Logger.info(`Each wallet will perform ${this.config.cyclesPerWallet} swap cycles`);
        Logger.info(`Swap range configured: ${this.config.swapAmount.min} - ${this.config.swapAmount.max} FOGO`);
        Logger.info(`Interval between full cycles: ${this.config.countdownHours} jam`);
        console.log();

        while (true) {
            await this.runTradingCycles();
            await this.countdown();
        }
    }

    async runTradingCycles() {
        for (const wallet of this.wallets) {
            Logger.info(`Starting wallet: ${wallet.address}`);
            
            for (let cycle = 1; cycle <= this.config.cyclesPerWallet; cycle++) {
                Logger.info(`Initiating cycle ${cycle}/${this.config.cyclesPerWallet}`);

                // Generate random amount
                const randomAmount = this.config.swapAmount.min + 
                    Math.random() * (this.config.swapAmount.max - this.config.swapAmount.min);
                const amountLamports = Math.floor(randomAmount * 1e9);
                Logger.info(`Selected amount: ${randomAmount.toFixed(6)} FOGO`);

                // First swap: FOGO to FUSD
                const fusdReceived = await this.swapEngine.executeSwap(wallet, amountLamports, 'TO_FUSD');
                
                if (fusdReceived > 0) {
                    Logger.info(`Pausing ${this.config.delayBetweenSwaps/1000} detik sebelum swap balik (reverse)`);
                    await this.swapEngine.delay(this.config.delayBetweenSwaps);

                    // Second swap: FUSD to FOGO
                    await this.swapEngine.executeSwap(wallet, fusdReceived, 'TO_FOGO');
                } else {
                    Logger.warn("Skipping reverse swap due to first swap failure");
                }

                if (cycle < this.config.cyclesPerWallet) {
                    await this.swapEngine.delay(this.config.delayBetweenCycles);
                }
                console.log();
            }
            Logger.success(`All cycles completed for wallet ${wallet.address}`);
            console.log();
        }
    }

    async countdown() {
        Logger.info(`Starting ${this.config.countdownHours} hour countdown until next run`);
        
        let remaining = this.config.countdownHours * 3600;
        const timer = setInterval(() => {
            const now = new Date();
            const currentTime = now.getHours().toString().padStart(2, '0') + ':' + 
                               now.getMinutes().toString().padStart(2, '0') + ':' + 
                               now.getSeconds().toString().padStart(2, '0');
            
            const h = Math.floor(remaining / 3600);
            const m = Math.floor((remaining % 3600) / 60);
            const s = remaining % 60;
            process.stdout.write(`\r[${currentTime}] Next cycle in: ${h}h ${m}m ${s}s`);
            
            if (--remaining <= 0) {
                clearInterval(timer);
                console.log();
                Logger.success("Countdown finished. Starting new cycle");
                console.log();
            }
        }, 1000);

        await this.swapEngine.delay(this.config.countdownHours * 3600 * 1000);
    }
}

// Create default config.json if not exists
function createDefaultConfig() {
    const defaultConfig = {
        "rpcUrl": "https://testnet.fogo.io/",
        "apiUrl": "https://api.valiant.trade",
        "paymasterUrl": "https://sessions-example.fogo.io/paymaster",
        "explorerUrl": "https://explorer.fogo.io/tx/",
        "feePayer": "8HnaXmgFJbvvJxSdjeNyWwMXZb85E35NM4XNg6rxuw3w",
        "tokens": {
            "FOGO": "So11111111111111111111111111111111111111112",
            "FUSD": "fUSDNGgHkZfwckbr5RLLvRbvqvRcTLdH9hcHJiq4jry"
        },
        "cyclesPerWallet": 4,
        "swapAmount": {
            "min": 0.00002,
            "max": 0.00003
        },
        "delayBetweenSwaps": 15000,
        "delayBetweenCycles": 10000,
        "countdownHours": 24
    };

    if (!fs.existsSync('config.json')) {
        fs.writeFileSync('config.json', JSON.stringify(defaultConfig, null, 2));
        Logger.success('Default config.json created');
    }

    if (!fs.existsSync('privatekey.txt')) {
        fs.writeFileSync('privatekey.txt', 'PUT_YOUR_PRIVATE_KEYS_HERE_ONE_PER_LINE');
        Logger.warn('Please add your private keys to privatekey.txt (one per line)');
        process.exit(1);
    }
}

// Initialize and start
createDefaultConfig();
const bot = new FogoBot();
bot.start().catch(error => {
    Logger.error('Fatal error occurred');
    console.error(error);
    process.exit(1);
});