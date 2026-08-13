# Security

BLOCKSTEP is free to play and does not request token approvals, transfers, seed phrases, or private keys.

## Player wallet boundary

The browser requests a wallet only after Run Cleared and only for an EIP-712 replay signature. The signed message is bound to the player, Hemi chain ID, deployed score contract, Bitcoin height, packed moves, and a short deadline.

## Verification service boundary

The service exposes only `GET /api/challenge` and `POST /api/verify`. It submits one fixed contract method with zero transaction value after schema, origin, signer, freshness, canonical-proof, rate, gas, fee, balance, and simulation checks.

`RELAYER_PRIVATE_KEY` is server-side only. Use a dedicated low-balance wallet and store its value in the hosting provider's encrypted secret mechanism. Never expose it through a `VITE_*` variable or commit it to source control.

## Contract boundary

`BlockstepScores` is immutable and has no owner, upgrade, withdrawal, payable, token, or arbitrary-call surface. The deployed source and bytecode are verified on Hemi Explorer.

## Current availability limit

Hemi has confirmed a BitcoinKit precompile issue affecting `getHeaderN`. The contract and verification service fail closed while this method is unavailable. Gameplay and local replay proofs continue to work, but no score should be presented as onchain-verified until the read succeeds again.

If you discover a security issue, avoid publishing credentials or exploit details in a public issue. Use the repository host's private vulnerability-reporting feature when available.
