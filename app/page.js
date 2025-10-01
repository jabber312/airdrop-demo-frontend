"use client";

import { useState, useMemo } from "react";
import Papa from "papaparse";
import { ethers } from "ethers";

const AIRDROPPER = process.env.NEXT_PUBLIC_AIRDROPPER_ADDRESS;
const TOKEN = process.env.NEXT_PUBLIC_TOKEN_ADDRESS;

// Minimal ABIs we need
const AIRDROPPER_ABI = [
  "function airdrop(address[] recipients, uint256[] amounts) external",
  "function token() view returns (address)"
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)"
];

export default function Home() {
  const [rows, setRows] = useState([]); // [{address, amountStr}]
  const [status, setStatus] = useState("");
  const [txHash, setTxHash] = useState("");
  const [decimals, setDecimals] = useState(18);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState("");

  const totalTokens = useMemo(() => {
    try {
      return rows.reduce((sum, r) => sum + (parseFloat(r.amountStr || "0") || 0), 0);
    } catch { return 0; }
  }, [rows]);

  async function connectWallet() {
    try {
      if (!window.ethereum) {
        alert("MetaMask not found. Please install it.");
        return;
      }
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send("eth_requestAccounts", []);
      setAccount(accounts[0] || "");
      setConnected(true);

      // Fetch token decimals for correct unit conversion
      const signer = await provider.getSigner();
      const erc20 = new ethers.Contract(TOKEN, ERC20_ABI, signer);
      const dec = await erc20.decimals();
      setDecimals(Number(dec));
      setStatus(`Connected: ${accounts[0]?.slice(0,6)}...${accounts[0]?.slice(-4)} | Token decimals: ${dec}`);
    } catch (e) {
      console.error(e);
      setStatus("Failed to connect wallet.");
    }
  }

  function handleCSV(file) {
    if (!file) return;
    setStatus("Parsing CSV...");
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: (res) => {
        try {
          // Expect exactly 2 columns: address, amount
          const parsed = res.data.map((row, idx) => {
            if (!Array.isArray(row) || row.length < 2) throw new Error(`Row ${idx+1} malformed`);
            const address = String(row[0]).trim();
            const amountStr = String(row[1]).trim();
            if (!ethers.isAddress(address)) {
              throw new Error(`Invalid address at row ${idx+1}: ${address}`);
            }
            if (isNaN(Number(amountStr)) || Number(amountStr) <= 0) {
              throw new Error(`Invalid amount at row ${idx+1}: ${amountStr}`);
            }
            return { address, amountStr };
          });
          setRows(parsed);
          setStatus(`Parsed ${parsed.length} rows. Total: ${totalTokens} tokens.`);
        } catch (e) {
          console.error(e);
          setRows([]);
          setStatus(`CSV error: ${e.message}`);
        }
      },
      error: (err) => {
        console.error(err);
        setStatus("CSV parse failed.");
      }
    });
  }

  async function runAirdrop() {
    try {
      if (!connected) return alert("Connect wallet first.");
      if (!rows.length) return alert("Upload a CSV first.");

      // Limit batch size for demo safety
      if (rows.length > 200) {
        return alert("Please keep CSV <= 200 rows for this demo.");
      }

      setLoading(true);
      setStatus("Preparing transaction...");

      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      // Prepare arrays
      const recipients = rows.map(r => r.address);
      const amounts = rows.map(r => ethers.parseUnits(r.amountStr, decimals)); // convert to token units

      const airdropper = new ethers.Contract(AIRDROPPER, AIRDROPPER_ABI, signer);

      // Optional: quick balance check
      const erc20 = new ethers.Contract(TOKEN, ERC20_ABI, signer);
      const bal = await erc20.balanceOf(AIRDROPPER);
      const need = amounts.reduce((s, a) => s + a, 0n);
      if (bal < need) {
        setLoading(false);
        return setStatus("Airdropper does not have enough tokens. Fund it first.");
      }

      setStatus("Sending transaction...");
      const tx = await airdropper.airdrop(recipients, amounts);
      setStatus("Waiting for confirmation...");
      const rcpt = await tx.wait();

      setTxHash(tx.hash);
      setStatus(`Success! Tx confirmed in block ${rcpt.blockNumber}.`);
    } catch (e) {
      console.error(e);
      setStatus(e?.shortMessage || e?.message || "Airdrop failed.");
    } finally {
      setLoading(false);
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
        <button onClick={runAirdrop} disabled={loading || !rows.length || !connected} style={{padding:"10px 14px", borderRadius:10}}>
          {loading ? "Sending..." : "Distribute"}
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
            Total (entered): {totalTokens} tokens (will be sent using {decimals}-decimals)
          </div>
        </div>
      )}
    </main>
  );
}
