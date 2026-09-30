#!/bin/sh
# Blocks commits that contain secrets or personal on-chain identifiers. POSIX sh (works with macOS's bash 3.2).
#
#   scripts/check-secrets.sh          scan files staged for commit (the pre-commit hook runs this)
#   scripts/check-secrets.sh --all    scan every file git would track
#
# Fails on: .env / database files, KEY=value secrets and token-looking strings, EVM addresses, 64-hex
# hashes/private keys, Solana-style addresses, and anything listed in .secrets-denylist (git-ignored:
# your wallet addresses, exchange account numbers, position ids — one per line).
# Placeholder addresses made of one repeated digit (0x1111…1111, 0x0000…0001) are allowed in tests.
cd "$(git rev-parse --show-toplevel)" || exit 1

if [ "$1" = "--all" ]; then
  list=$(git ls-files --cached --others --exclude-standard)
else
  list=$(git diff --cached --name-only --diff-filter=ACMR)
fi
[ -z "$list" ] && exit 0

tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
n=0
echo "$list" | while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in
    .env.example) ;;
    .env|*/.env|.env.*|*.db|*.db-*|*.sqlite|data/*|.secrets-denylist) echo "✖ $f: this file must never be committed" >> "$tmp" ;;
  esac
  case "$f" in package-lock.json|scripts/check-secrets.sh) continue ;; esac

  # Secrets: KEY=value with a real value, and well-known token prefixes.
  grep -nE '^[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*=[^[:space:]#]{6,}' "$f" | sed "s|=.*|=<redacted>|; s|^|✖ $f:|; s|$|  (secret value)|" >> "$tmp"
  grep -noE '(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})' "$f" | sed "s|^|✖ $f:|; s|$|  (token)|" >> "$tmp"

  # EVM addresses, except repeated-digit placeholders.
  grep -noE '0x[0-9a-fA-F]{40}' "$f" | grep -vE ':0x(0{39}[0-9a-fA-F]|([0-9a-fA-F])\2{39})$' | sed "s|^|✖ $f:|; s|$|  (wallet/contract address)|" >> "$tmp"
  # 64-hex strings: transaction hashes or private keys.
  grep -noE '(^|[^0-9a-fA-Fx])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)' "$f" | sed "s|^|✖ $f:|; s|$|  (64-hex: tx hash or private key)|" >> "$tmp"
  # Solana-style base58 addresses (need both letters and digits; skip 1111… system program).
  grep -noE '[1-9A-HJ-NP-Za-km-z]{32,44}' "$f" | grep -E ':[^:]*[0-9][^:]*$' | grep -E ':[^:]*[A-Za-z][^:]*$' | grep -vE ':1+$' | grep -vE ':x[0-9a-fA-F]+$' \
    | sed "s|^|✖ $f:|; s|$|  (possible Solana address)|" >> "$tmp"

  # Personal identifiers from the local denylist.
  if [ -f .secrets-denylist ]; then
    grep -vE '^[[:space:]]*(#|$)' .secrets-denylist | while IFS= read -r term; do
      if grep -qiF -- "$term" "$f"; then echo "✖ $f: contains a denylisted identifier ($(printf %.4s "$term")…)" >> "$tmp"; fi
    done
  fi
done
count=$(echo "$list" | wc -l | tr -d ' ')

if [ -s "$tmp" ]; then
  cat "$tmp"
  echo
  echo "Commit blocked: remove the items above (or use placeholders) and try again."
  exit 1
fi
echo "✓ No secrets or personal identifiers found in $count file(s)."
