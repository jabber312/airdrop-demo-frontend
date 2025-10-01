"use client";

import React, { useMemo, useState } from "react";
import Papa from "papaparse";
import { ethers } from "ethers";

// ====== ENV (set on Vercel) ======
const AIRDROPPER = process.env.NEXT_PUBLIC_AIRDROPPER_ADDRESS; // 0x...
const TOKEN = process.env.NEXT_PUBLIC_TOKEN_ADDRESS;           // 0x...

// ====== Minimal ABIs ======
const AIRDROPPER_ABI = [
  "function airdrop(address[] recipients, uint256[] amounts) external",
  "function token() view returns (address)",
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

// Pick the MetaMask provider even if multiple wallets inject window.ethereum
function getMetaMaskProvider() {
  if (typeof window === "undefined") return null;
  const eth = window.ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers)) {
    const mm = eth.providers.find((p) => p && p.isMetaMask);
    if (mm) return mm;
  }
  if (eth.isMetaMask) return eth;
  if (eth.provider && eth.provider.isMetaMask) return eth.provider;
  return null;
}

export default function Home() {
  const [rows, setRows] = useState([]);         // [{address, amountStr}]
  const [status, setStatus] = useState("");
  const [txHash, setTxHash] = useState("");
  const [decimals, setDecimals] = useState(18);
  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState("");

  const totalTokens = useMemo(() => {
    try {
      return rows.reduce((sum, r) => sum + (parseFloat(r.amountStr || "0") || 0), 0);
    } catch { return 0; }
  }, [rows]);

  // ---------- Connect Wallet (MetaMask only) ----------
  async function connectWallet() {
    try {
      // Guard: only in browser + require MetaMask
      const mm = getMetaMaskProvider();
      if (!mm) {
        setStatus("MetaMask not detected. If a chooser opens, pick 'Use MetaMask'.");
        alert("Please choose 'Use MetaMask' in the wallet popup (or disable Phantom for this site) and try again.");
        return;
      }

      // Use BrowserProvider with the MetaMask provider
      const provider = new ethers.BrowserProvider(mm);

      // Request accounts
      await provider.send("eth_requestAccounts", []);

      // Ensure Sepolia (chainId 11155111)
      const SEPOLIA_HEX = "0xaa36a7";
      try {
        await mm.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_HEX }] });
      } catch (e) {
        // If chain not added, add then switch
        if (e && e.code === 4902) {
          await mm.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: SEPOLIA_HEX,
              chainName: "Sepolia",
              nativeCurrency: { name: "SepoliaETH", symbol: "SEP", decimals: 18 },
              rpcUrls: ["https://rpc.sepolia.org"],
              blockExplorerUrls: ["https://sepolia.etherscan.io"],
            }],
          });
        }
      }

      const signer = await provider.getSigner();
      const addr = await signer.getAddress();
      setConnected(true);
      setAccount(addr);

      // Get token decimals (best effort)
      try {
        const erc20 = new ethers.Contract(TOKEN, ERC20_ABI, signer);
        const dec = await erc20.decimals();
        setDecimals(Number(dec));
        setStatus(`Connected: ${addr.slice(0,6)}...${addr.slice(-4)} | Token decimals: ${dec}`);
      } catch {
        setStatus(`Connected: ${addr.slice(0,6)}...${addr.slice(-4)}`);
      }
    } catch (err) {
      console.error("Wallet connect error:", err);
      // 4001 = user rejected
      if (err && err.code === 4001) setStatus("Connection request was rejected in MetaMask.");
      else setStatus("Failed to connect wallet. Please ensure MetaMask is selected.");
    }
  }

  // ---------- CSV Upload ----------
  function handleCSV(file) {
    if (!file) return;
    setStatus("Parsing CSV...");
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: (res) => {
        try {
          const parsed = res.data.map((row, idx) => {
            if (!Array.isArray(row) || row.length < 2) throw new Error(`Row ${idx + 1} malformed`);
            const address = String(row[0]).trim();
            const amountStr = String(row[1]).trim();
            if (!ethers.isAddress(address)) throw new Error(`Invalid address at row ${idx + 1}: ${address}`);
            if (isNaN(Number(amountStr)) || Number(amountStr) <= 0) throw new Error(`Invalid amount at row ${idx + 1}: ${amountStr}`);
            return { address, amountStr };
          });
          setRows(parsed);
          setStatus(`Parsed ${parsed.length} rows. Total: ${parsed.reduce((s, r) => s + Number(r.amountStr), 0)} tokens.`);
        } catch (e) {
          console.error(e);
          setRows([]);
          setStatus(`CSV error: ${e.message}`);
        }
      },
      error: (err) => {
        console.error(err);
        setStatus("CSV parse failed.");
      },
    });
  }

  // ---------- Run Airdrop ----------
  async function runAirdrop() {
    try {
      if (!connected) return alert("Connect wallet first.");
      if (!rows.length) return alert("Upload a CSV first.");
      if (!AIRDROPPER || !TOKEN) return alert("Env vars missing. Set NEXT_PUBLIC_* on Vercel.");

      setStatus("Preparing transaction...");

      // Always re-create provider from current window.ethereum
      if (typeof window === "undefined" || !window.ethereum) {
        setStatus("MetaMask not detected in browser.");
        return;
      }
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const recipients = rows.map((r) => r.address);
      const amounts = rows.map((r) => ethers.parseUnits(r.amountStr, decimals));

      const airdropper = new ethers.Contract(AIRDROPPER, AIRDROPPER_ABI, signer);

      // Optional safety: check balance first
      const erc20 = new ethers.Contract(TOKEN, ERC20_ABI, signer);
      const bal = await erc20.balanceOf(AIRDROPPER);
      const need = amounts.reduce((s, a) => s + a, 0n);
      if (bal < need) {
        setStatus("Airdropper does not have enough tokens. Please fund it first.");
        return;
      }

      setStatus("Sending transaction...");
      const tx = await airdropper.airdrop(recipients, amounts);
      setStatus("Waiting for confirmation...");
      const rcpt = await tx.wait();

      setTxHash(tx.hash);
      setStatus(`Success! Confirmed in block ${rcpt.blockNumber}.`);
    } catch (e) {
      console.error("Airdrop error:", e);
      setStatus(e?.shortMessage || e?.message || "Airdrop failed.");
    }
  }

  const etherscanBase = "https://sepolia.etherscan.io/tx/";

  return (
    <main style={{maxWidth: 780, margin: "40px auto", padding: 16, fontFamily: "ui-sans-serif, system-ui"}}>
      <h1 style={{fontSize: 28, fontWeight: 700, marginBottom: 12}}>CSV Airdrop Demo</h1>
      <p style={{opacity: 0.8, marginBottom: 16}}>
        1) Connect wallet (Sepolia) → 2) Upload CSV (<code>address,amount</code>) → 3) Distribute
      </p>

      <div style={{display:"flex", gap:12, marginBottom:16}}>
        <button onClick={connectWallet} disabled={connected} style={{padding:"10px 14px", borderRadius:10}}>
          {connected ? "Wallet Connected" : "Connect MetaMask"}
        </button>

        <label style={{padding:"10px 14px", border:"1px dashed #999", borderRadius:10, cursor:"pointer"}}>
          Upload CSV
          <input type="file" accept=".csv" onChange={(e)=>handleCSV(e.target.files?.[0])} style={{display:"none"}} />
        </label>

        <button onClick={runAirdrop} disabled={!rows.length || !connected} style={{padding:"10px 14px", borderRadius:10}}>
          Distribute
        </button>
      </div>

      {status && <div style={{marginBottom:12}}><b>Status:</b> {status}</div>}

      {txHash && (
        <div style={{marginBottom:12}}>
          <b>Tx:</b>{" "}
          <a href={etherscanBase + txHash} target="_blank" rel="noreferrer">
            {txHash.slice(0,10)}...{txHash.slice(-8)}
          </a>
        </div>
      )}

      {!!rows.length && (
        <div style={{marginTop: 10}}>
          <b>Preview ({rows.length} rows)</b>
          <ul style={{maxHeight: 260, overflow: "auto", paddingLeft: 18}}>
            {rows.map((r, i) => (
              <li key={i} style={{fontFamily:"monospace"}}>
                {r.address} , {r.amountStr}
              </li>
            ))}
          </ul>
          <div style={{marginTop:8, opacity:0.8}}>
            Total (entered): {totalTokens} tokens (sending with {decimals}-decimals)
          </div>
        </div>
      )}
    </main>
  );
}
