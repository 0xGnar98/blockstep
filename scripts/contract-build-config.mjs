import fs from "node:fs";
import path from "node:path";

import solc from "solc";
import { keccak256, toHex } from "viem";

export const ROOT = process.cwd();
export const SCORE_SOURCE_NAME = "BlockstepScores.sol";
export const SCORE_CONTRACT_NAME = "BlockstepScores";
export const MOCK_SOURCE_NAME = "MockBitcoinKit.sol";
export const MOCK_CONTRACT_NAME = "MockBitcoinKit";

export const SCORE_SOURCE_PATH = path.join(ROOT, "contracts", SCORE_SOURCE_NAME);
export const MOCK_SOURCE_PATH = path.join(ROOT, "contracts", "test", MOCK_SOURCE_NAME);

// Paris is deliberately explicit. It avoids relying on solc's moving default EVM
// target and produces bytecode that remains valid on later EVM hardforks.
export const COMPILER_SETTINGS = Object.freeze({
  optimizer: Object.freeze({ enabled: true, runs: 200 }),
  viaIR: true,
  evmVersion: "paris",
});

export const OUTPUT_SELECTION = Object.freeze({
  "*": Object.freeze({
    "*": Object.freeze([
      "abi",
      "metadata",
      "evm.bytecode.object",
      "evm.deployedBytecode.object",
      "evm.deployedBytecode.immutableReferences",
      "evm.gasEstimates",
    ]),
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function readSources({ includeMock = false } = {}) {
  const sources = {
    [SCORE_SOURCE_NAME]: { content: fs.readFileSync(SCORE_SOURCE_PATH, "utf8") },
  };
  if (includeMock) {
    sources[MOCK_SOURCE_NAME] = { content: fs.readFileSync(MOCK_SOURCE_PATH, "utf8") };
  }
  return sources;
}

export function createCompilerInput({ includeMock = false } = {}) {
  return {
    language: "Solidity",
    sources: readSources({ includeMock }),
    settings: {
      ...clone(COMPILER_SETTINGS),
      outputSelection: clone(OUTPUT_SELECTION),
    },
  };
}

export function compileInput(input) {
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const diagnostics = output.errors ?? [];
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  }
  return { output, diagnostics };
}

export function getCompiledContract(output, sourceName, contractName) {
  const compiled = output.contracts?.[sourceName]?.[contractName];
  if (!compiled) throw new Error(`Missing compiled contract ${sourceName}:${contractName}`);
  return compiled;
}

export function prefixedBytecode(object) {
  return `0x${object}`;
}

export function sourceHash(source) {
  return keccak256(toHex(source));
}

export function bytecodeHash(bytecode) {
  return keccak256(bytecode);
}

export function compilerVersion() {
  return solc.version();
}

export function buildArtifact(compiled, sourceContent) {
  const bytecode = prefixedBytecode(compiled.evm.bytecode.object);
  const deployedBytecode = prefixedBytecode(compiled.evm.deployedBytecode.object);
  return {
    contractName: SCORE_CONTRACT_NAME,
    sourceName: SCORE_SOURCE_NAME,
    abi: compiled.abi,
    bytecode,
    deployedBytecode,
    build: {
      compiler: compilerVersion(),
      settings: clone(COMPILER_SETTINGS),
      sourceHash: sourceHash(sourceContent),
      creationCodeHash: bytecodeHash(bytecode),
      runtimeTemplateCodeHash: bytecodeHash(deployedBytecode),
      immutableReferences: compiled.evm.deployedBytecode.immutableReferences ?? {},
      creationBytes: (bytecode.length - 2) / 2,
      runtimeBytes: (deployedBytecode.length - 2) / 2,
    },
  };
}
