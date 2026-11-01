// Experimental fold-point carrier relocation (switch A + switch B): host-side
// coverage for the two knobs (env > file > OFF), config parsing, settings
// mapping into the kernel Config, and the signed/strict-echo drop-predicate
// doctrine (#1658/#684). Kernel pipeline behavior is covered by
// kernel/tests/relocate-compress.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, type CoreMessage } from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { parseCompressSettings } from "../src/config.ts";
import { resolveCompressAtFoldPoint, resolveCompressAtFoldPointClearThinking } from "../src/knobs.ts";
import { makeFoldPointReasoningDroppable } from "../src/server.ts";

function withEnv(key: string, value: string | undefined, fn: () => void): void {
    const prev = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
        fn();
    } finally {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
    }
}

test("resolveCompressAtFoldPoint: env tier wins, garbage falls through, default off", () => {
    assert.equal(resolveCompressAtFoldPoint({ BILI_COMPRESS_AT_FOLD_POINT: "1" } as NodeJS.ProcessEnv), true);
    assert.equal(resolveCompressAtFoldPoint({ BILI_COMPRESS_AT_FOLD_POINT: "ON" } as NodeJS.ProcessEnv), true);
    assert.equal(resolveCompressAtFoldPoint({ BILI_COMPRESS_AT_FOLD_POINT: " 0 " } as NodeJS.ProcessEnv, true), false, "env 0 beats file true");
    assert.equal(resolveCompressAtFoldPoint({ BILI_COMPRESS_AT_FOLD_POINT: "bogus" } as NodeJS.ProcessEnv, true), true, "garbage env falls to file");
    assert.equal(resolveCompressAtFoldPoint({ BILI_COMPRESS_AT_FOLD_POINT: "" } as NodeJS.ProcessEnv, false), false);
    assert.equal(resolveCompressAtFoldPoint({} as NodeJS.ProcessEnv), false, "default off");
    assert.equal(resolveCompressAtFoldPoint({} as NodeJS.ProcessEnv, true), true, "file bool honored");
    assert.equal(resolveCompressAtFoldPoint({} as NodeJS.ProcessEnv, "yes"), false, "non-bool file ignored");
});

test("resolveCompressAtFoldPointClearThinking: same tiers, default off", () => {
    assert.equal(resolveCompressAtFoldPointClearThinking({ BILI_COMPRESS_AT_FOLD_POINT_CLEAR_THINKING: "on" } as NodeJS.ProcessEnv), true);
    assert.equal(resolveCompressAtFoldPointClearThinking({ BILI_COMPRESS_AT_FOLD_POINT_CLEAR_THINKING: "off" } as NodeJS.ProcessEnv, true), false);
    assert.equal(resolveCompressAtFoldPointClearThinking({ BILI_COMPRESS_AT_FOLD_POINT_CLEAR_THINKING: "?" } as NodeJS.ProcessEnv, true), true);
    assert.equal(resolveCompressAtFoldPointClearThinking({} as NodeJS.ProcessEnv), false);
    assert.equal(resolveCompressAtFoldPointClearThinking({} as NodeJS.ProcessEnv, true), true);
});

test("parseCompressSettings: accepts both fold-point booleans, rejects non-boolean", () => {
    const ok = parseCompressSettings({ compressAtFoldPoint: true, compressAtFoldPointClearThinking: true });
    assert.equal(ok?.compressAtFoldPoint, true);
    assert.equal(ok?.compressAtFoldPointClearThinking, true);
    assert.equal(parseCompressSettings({ compressAtFoldPoint: false })?.compressAtFoldPoint, false, "explicit false kept");
    assert.equal(parseCompressSettings({ compressAtFoldPoint: "yes" }), undefined, "non-boolean rejected");
    assert.equal(parseCompressSettings({ compressAtFoldPointClearThinking: 1 }), undefined, "non-boolean rejected");
});

test("applyCompressSettings: maps file flags and lets env override", () => {
    const base = defaultConfig(200000);
    withEnv("BILI_COMPRESS_AT_FOLD_POINT", undefined, () => {
        withEnv("BILI_COMPRESS_AT_FOLD_POINT_CLEAR_THINKING", undefined, () => {
            const on = applyCompressSettings(base, 200000, { compressAtFoldPoint: true, compressAtFoldPointClearThinking: true });
            assert.equal(on.compressAtFoldPoint, true);
            assert.equal(on.compressAtFoldPointClearThinking, true);
            const off = applyCompressSettings(base, 200000, {});
            assert.equal(off.compressAtFoldPoint, false, "unset file flag resolves off (explicit pass-through)");
            assert.equal(off.compressAtFoldPointClearThinking, false);
        });
    });
    withEnv("BILI_COMPRESS_AT_FOLD_POINT", "0", () => {
        const out = applyCompressSettings(base, 200000, { compressAtFoldPoint: true });
        assert.equal(out.compressAtFoldPoint, false, "env 0 beats file true");
    });
    withEnv("BILI_COMPRESS_AT_FOLD_POINT", "1", () => {
        const out = applyCompressSettings(base, 200000, { compressAtFoldPoint: false });
        assert.equal(out.compressAtFoldPoint, true, "env 1 beats file false");
    });
});

test("makeFoldPointReasoningDroppable: strict-echo / signed views never get a predicate", () => {
    const unsignedReasoning: CoreMessage = { id: "r1", role: "assistant", contentType: "reasoning", text: "thinking..." };
    const signedReasoning: CoreMessage & { thinkingSignature?: string } = { id: "r2", role: "assistant", contentType: "reasoning", text: "signed", thinkingSignature: "sig123" };
    const userMsg: CoreMessage = { id: "u1", role: "user", contentType: "text", text: "hi" };
    // strictEcho ⇒ undefined (no predicate at all, #684)
    assert.equal(makeFoldPointReasoningDroppable([unsignedReasoning] as never[], true), undefined);
    // any signed block in view ⇒ undefined (#1658 presence gate)
    assert.equal(makeFoldPointReasoningDroppable([unsignedReasoning, signedReasoning] as never[], false), undefined);
    // clean view ⇒ predicate that drops only unsigned reasoning cores
    const pred = makeFoldPointReasoningDroppable([userMsg, unsignedReasoning] as never[], false);
    assert(typeof pred === "function");
    assert.equal(pred!(unsignedReasoning), true, "unsigned reasoning droppable");
    assert.equal(pred!({ ...signedReasoning }), false, "signed reasoning protected");
    assert.equal(pred!(userMsg), true, "non-reasoning core is not a think run member (predicate consulted per core by kernel walk)");
});
