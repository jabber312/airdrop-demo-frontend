"use client";

import React, { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import { ethers } from "ethers";

/** ====== ENV (PUBLIC) ====== */
/* Strip ALL whitespace/newlines to avoid ENS error */
const AIRDROPPER = (process.env.NEXT_PUBLIC_AIRDROPPER_ADDRESS || "").replace(/\s+/g, "");
const TOKEN      = (process.env.NEXT_PUBLIC_TOKEN_ADDRESS || "").replace(/\s+/g, "");

/** ====== ABIs ====== */
const AIRDROPPER_ABI = ["function airdrop(address[] recipients, uint256[] amounts) external"];
const ERC20_ABI = ["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"];

/** Pick MetaMask provider even if multiple wallets are installed */
function getMetaMask() {
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
  const [rows, setRows] = useState([]);               // Parsed CSV rows
  const [status, setStatus] = useState("");           // Status message
  const [txHash, setTxHash] = useState("");           // Transaction hash
  const [decimals, setDecimals] = useState(18);       // Token decimals
  const [connected, setConnected] = useState(false);  // Wallet connection state
  const [account, setAccount] = useState("");         // Connected account

  // Diagnostics
  const [diag, setDiag] = useState({
    hasWindow: false,
    hasEthereum: false,
    providers: [],
    isMetaMask: false,
    chainId: "",
    envAirdropper: AIRDROPPER,
    envToken: TOKEN,
  });

  // Show quick diagnostics on load
  useEffect(() => {
    if (typeof window === "undefined") return;
    const eth = window.ethereum;
    const providers = Array.isArray(eth?.providers)
      ? eth.providers.map((p) => ({
          isMetaMask: !!p?.isMetaMask,
          name: p?.isMetaMask ? "MetaMask" : "Other",
        }))
      : [];
    setDiag({
      hasWindow: true,
      hasEthereum: !!eth,
      providers,
      isMetaMask: !!eth?.isMetaMask || !!eth?.provider?.isMetaMask || providers.some((p) => p.isMetaMask),
      chainId: eth?.chainId || "",
      envAirdropper: AIRDROPPER,
      envToken: TOKEN,
    });
  }, []);

  // Compute total tokens from CSV
  const totalTokens = useMemo(
    () => rows.reduce((s, r) => s + (parseFloat(r.amountStr || "0") || 0), 0),
    [rows]
  );

  /** ---------- Step 1: Connect MetaMask ---------- */
  async function connectWallet() {
    try {
      // 1) Must be in browser and MetaMask present
      const mm = getMetaMask();
      if (!mm) {
        setStatus("MetaMask not found. Install & enable it, then refresh. (Tip: disable Brave/Phantom/Coinbase wallets.)");
        return;
      }

      // 2) Ask for accounts FIRST (triggers popup)
      const accounts = await mm.request({ method: "eth_requestAccounts" });
      if (!accounts || !accounts.length) {
        setStatus("No account authorized in MetaMask.");
        return;
      }

      // 3) Ensure network = Sepolia (11155111)
      const SEPOLIA_HEX = "0xaa36a7";
      try {
        await mm.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_HEX }] });
      } catch (e) {
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
        } else {
          throw e;
        }
      }

      // 4) Create ethers provider & signer AFTER accounts approved
      const provider = new ethers.BrowserProvider(mm);
      const signer = await provider.getSigner();
      const addr = await signer.getAddress();

      setConnected(true);
      setAccount(addr);

      // 5) Try to read token decimals (nice-to-have)
      if (ethers.isAddress(TOKEN)) {
        try {
          const erc20 = new ethers.Contract(TOKEN, ERC20_ABI, signer);
          const dec = await erc20.decimals();
          setDecimals(Number(dec));
          setStatus(`Connected: ${addr.slice(0,6)}...${addr.slice(-4)} | Token decimals: ${dec}`);
        } catch {
          setStatus(`Connected: ${addr.slice(0,6)}...${addr.slice(-4)}`);
        }
      } else {
        setStatus(`Connected: ${addr.slice(0,6)}...${addr.slice(-4)}`);
      }
    } catch (err) {
      console.error("Connect error:", err);
      const code = err?.code ? ` (code ${err.code})` : "";
      const msg = err?.message || "Unknown error";
      setStatus(`Failed to connect wallet${code}: ${msg}`);
    }
  }

  /** ---------- Step 2: Upload & Parse CSV ---------- */
  function handleCSV(file) {
    if (!file) return;
    setStatus("Parsing CSV...");
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: (res) => {
        try {
          const parsed = res.data.map((row, i) => {
            if (!Array.isArray(row) || row.length < 2) throw new Error(`Row ${i + 1} malformed`);
            const address = String(row[0]).trim();
            const amountStr = String(row[1]).trim();
            if (!ethers.isAddress(address)) throw new Error(`Invalid address at row ${i + 1}: ${address}`);
            if (isNaN(Number(amountStr)) || Number(amountStr) <= 0) throw new Error(`Invalid amount at row ${i + 1}: ${amountStr}`);
            return { address, amountStr };
          });
          setRows(parsed);
          setStatus(`Parsed ${parsed.length} rows. Total: ${parsed.reduce((s, r) => s + Number(r.amountStr), 0)} tokens.`);
        } catch (e) {
          setRows([]);
          setStatus(`CSV error: ${e.message}`);
        }
      },
      error: (e) => {
        console.error(e);
        setStatus("CSV parse failed.");
      },
    });
  }

  /** ---------- Step 3: Run Airdrop ---------- */
  async function runAirdrop() {
    try {
      if (!connected) return alert("Connect wallet first.");
      if (!rows.length) return alert("Upload a CSV first.");
      if (!ethers.isAddress(AIRDROPPER) || !ethers.isAddress(TOKEN)) {
        return alert("Missing or invalid addresses. Check your Vercel env vars.");
      }

      setStatus("Preparing transaction...");

      const mm = getMetaMask();
      if (!mm) { setStatus("MetaMask not detected."); return; }

      const provider = new ethers.BrowserProvider(mm);
      const signer = await provider.getSigner();

      const recipients = rows.map((r) => r.address);
      const amounts = rows.map((r) => ethers.parseUnits(r.amountStr, decimals));

      // Safety check: ensure the airdropper contract has enough tokens
      const erc20 = new ethers.Contract(TOKEN, ERC20_ABI, signer);
      const bal = await erc20.balanceOf(AIRDROPPER);
      const need = amounts.reduce((s, a) => s + a, 0n);
      if (bal < need) { setStatus("Airdropper does not have enough tokens."); return; }

      // Call airdrop contract
      const airdropper = new ethers.Contract(AIRDROPPER, AIRDROPPER_ABI, signer);
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

  /** ---------- Render UI ---------- */
  return (
    <main style={{ maxWidth: 840, margin: "40px auto", padding: 16, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}>CSV Airdrop Demo</h1>
      <p style={{ opacity: 0.8, marginBottom: 16 }}>
        1) Connect wallet (Sepolia) → 2) Upload CSV (<code>address,amount</code>) → 3) Distribute
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <button onClick={connectWallet} disabled={connected} style={{ padding: "10px 14px", borderRadius: 10 }}>
          {connected ? "Wallet Connected" : "Connect MetaMask"}
        </button>

        <label style={{ padding: "10px 14px", border: "1px dashed #999", borderRadius: 10, cursor: "pointer" }}>
          Upload CSV
          <input type="file" accept=".csv" onChange={(e) => handleCSV(e.target.files?.[0])} style={{ display: "none" }} />
        </label>

        <button onClick={runAirdrop} disabled={!rows.length || !connected} style={{ padding: "10px 14px", borderRadius: 10 }}>
          Distribute
        </button>
      </div>

      {status && <div style={{ marginBottom: 12 }}><b>Status:</b> {status}</div>}

      {txHash && (
        <div style={{ marginBottom: 12 }}>
          <b>Tx:</b>{" "}
          <a href={etherscanBase + txHash} target="_blank" rel="noreferrer">
            {txHash.slice(0, 10)}...{txHash.slice(-8)}
          </a>
        </div>
      )}

      {/* Diagnostics panel to quickly see what's wrong in prod */}
      <div style={{ marginTop: 16, padding: 12, border: "1px solid #333", borderRadius: 10 }}>
        <b>Diagnostics</b>
        <div style={{ fontSize: 13, opacity: 0.95, marginTop: 8 }}>
          <div>window detected: {String(diag.hasWindow)}</div>
          <div>window.ethereum: {String(diag.hasEthereum)}</div>
          <div>has MetaMask: {String(diag.isMetaMask)}</div>
          <div>chainId (hex): {diag.chainId || "(unknown)"}</div>
          <div>providers: {diag.providers.map((p) => p.name).join(", ") || "(none)"}</div>
          <div>Airdropper env: {AIRDROPPER || "(missing)"}</div>
          <div>Token env: {TOKEN || "(missing)"}</div>
        </div>
      </div>

      {!!rows.length && (
        <div style={{ marginTop: 16 }}>
          <b>Preview ({rows.length} rows)</b>
          <ul style={{ maxHeight: 260, overflow: "auto", paddingLeft: 18 }}>
            {rows.map((r, i) => (
              <li key={i} style={{ fontFamily: "monospace" }}>
                {r.address} , {r.amountStr}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 8, opacity: 0.8 }}>
            Total (entered): {totalTokens} tokens (sending with {decimals}-decimals)
          </div>
        </div>
      )}
    </main>
  );
}
