/**
 * Tests for the Knowledge System — Spec 05.
 *
 * Phase 1: File operations (upsert, read, list, exists)
 * Phase 2: Filename validation (naming rules, path traversal, non-.md rejection)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeStore } from "./knowledge.ts";

describe("KnowledgeStore", () => {
  let tempDir: string;
  let store: KnowledgeStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-coder-knowledge-test-"));
    store = new KnowledgeStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Phase 1: File Operations
  // -------------------------------------------------------------------------

  describe("upsert", () => {
    it("creates a knowledge file in the knowledge directory", () => {
      const result = store.upsert("supabase-auth-flow.md", "# Supabase Auth\n\nUse PKCE flow.");
      assert.ok(result.includes("supabase-auth-flow.md"));
      assert.ok(existsSync(join(tempDir, "supabase-auth-flow.md")));
    });

    it("overwrites an existing file", () => {
      store.upsert("test-file.md", "version 1");
      store.upsert("test-file.md", "version 2");
      const content = store.read("test-file.md");
      assert.equal(content, "version 2");
    });

    it("creates the knowledge directory if it does not exist", () => {
      const nestedDir = join(tempDir, "nested", "knowledge");
      const nestedStore = new KnowledgeStore(nestedDir);
      assert.ok(!existsSync(nestedDir));
      nestedStore.upsert("new-file.md", "content");
      assert.ok(existsSync(nestedDir));
      assert.ok(existsSync(join(nestedDir, "new-file.md")));
    });

    it("returns the full file path on success", () => {
      const result = store.upsert("my-rules.md", "be excellent");
      assert.equal(result, join(tempDir, "my-rules.md"));
    });
  });

  describe("read", () => {
    it("returns file content as a string", () => {
      store.upsert("api-conventions.md", "# API Conventions\n\nUse REST.");
      const content = store.read("api-conventions.md");
      assert.equal(content, "# API Conventions\n\nUse REST.");
    });

    it("returns null if the file does not exist", () => {
      const content = store.read("nonexistent.md");
      assert.equal(content, null);
    });
  });

  describe("list", () => {
    it("returns all .md filenames in the directory", () => {
      store.upsert("first.md", "one");
      store.upsert("second.md", "two");
      store.upsert("third.md", "three");
      const files = store.list();
      assert.deepEqual(files.sort(), ["first.md", "second.md", "third.md"]);
    });

    it("returns only filenames, not full paths", () => {
      store.upsert("path-check.md", "content");
      const files = store.list();
      for (const f of files) {
        assert.ok(!f.includes("/"), `Expected filename only, got path: ${f}`);
        assert.ok(!f.includes("\\"), `Expected filename only, got path: ${f}`);
      }
    });

    it("returns an empty array for an empty directory", () => {
      mkdirSync(tempDir, { recursive: true });
      const files = store.list();
      assert.deepEqual(files, []);
    });

    it("returns an empty array when the directory does not exist", () => {
      const ghostDir = join(tempDir, "does-not-exist");
      const ghostStore = new KnowledgeStore(ghostDir);
      const files = ghostStore.list();
      assert.deepEqual(files, []);
    });

    it("only returns .md files, not other files in the directory", () => {
      writeFileSync(join(tempDir, "readme.txt"), "not markdown");
      writeFileSync(join(tempDir, "valid.md"), "markdown");
      const files = store.list();
      assert.deepEqual(files, ["valid.md"]);
    });
  });

  describe("exists", () => {
    it("returns true when the file exists", () => {
      store.upsert("exists-check.md", "content");
      assert.equal(store.exists("exists-check.md"), true);
    });

    it("returns false when the file does not exist", () => {
      assert.equal(store.exists("missing.md"), false);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2: Naming Safety
  // -------------------------------------------------------------------------

  describe("filename validation", () => {
    it("accepts valid filenames", () => {
      const validNames = [
        "supabase-auth-flow.md",
        "api-conventions.md",
        "error-handling.md",
        "abc.md",           // 3-char stem (minimum)
        "a".repeat(50) + ".md",  // 50-char stem (maximum)
        "with-numbers-123.md",
      ];
      for (const name of validNames) {
        assert.doesNotThrow(() => store.upsert(name, "content"), `Expected ${name} to be valid`);
      }
    });

    it("rejects filenames that do not end in .md", () => {
      assert.throws(
        () => store.upsert("readme.txt", "content"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes(".md"), `Error should mention .md rule: ${err.message}`);
          return true;
        },
      );
    });

    it("rejects filenames with a stem shorter than 3 characters", () => {
      assert.throws(
        () => store.upsert("ab.md", "content"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("3-50"), `Error should mention length rule: ${err.message}`);
          return true;
        },
      );
    });

    it("rejects filenames with a stem longer than 50 characters", () => {
      const longName = "a".repeat(51) + ".md";
      assert.throws(
        () => store.upsert(longName, "content"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("3-50"), `Error should mention length rule: ${err.message}`);
          return true;
        },
      );
    });

    it("rejects filenames with uppercase letters in the stem", () => {
      assert.throws(
        () => store.upsert("CamelCase.md", "content"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("lowercase"), `Error should mention lowercase rule: ${err.message}`);
          return true;
        },
      );
    });

    it("rejects filenames with spaces in the stem", () => {
      assert.throws(
        () => store.upsert("has spaces.md", "content"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("alphanumeric"), `Error should mention alphanumeric rule: ${err.message}`);
          return true;
        },
      );
    });

    it("rejects filenames with underscores in the stem", () => {
      assert.throws(
        () => store.upsert("has_underscore.md", "content"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("alphanumeric"), `Error should mention alphanumeric rule: ${err.message}`);
          return true;
        },
      );
    });
  });

  describe("path traversal prevention", () => {
    it("rejects ../ in the filename", () => {
      assert.throws(
        () => store.upsert("../etc/passwd.md", "content"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("path"), `Error should mention path restriction: ${err.message}`);
          return true;
        },
      );
    });

    it("rejects nested directory paths", () => {
      assert.throws(
        () => store.upsert("sub/dir/file.md", "content"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("path"), `Error should mention path restriction: ${err.message}`);
          return true;
        },
      );
    });

    it("rejects absolute paths", () => {
      assert.throws(
        () => store.upsert("/etc/passwd.md", "content"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("path"), `Error should mention path restriction: ${err.message}`);
          return true;
        },
      );
    });

    it("rejects Windows absolute paths", () => {
      assert.throws(
        () => store.upsert("C:\\Windows\\System32\\file.md", "content"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("path"), `Error should mention path restriction: ${err.message}`);
          return true;
        },
      );
    });
  });

  describe("error messages include naming rules", () => {
    it("includes all naming rules in validation error messages", () => {
      try {
        store.upsert("BAD FILE.txt", "content");
        assert.fail("Expected an error to be thrown");
      } catch (err) {
        assert.ok(err instanceof Error);
        const msg = err.message;
        // Error should contain enough info to correct the filename
        assert.ok(msg.includes(".md"), "Should mention .md requirement");
        assert.ok(msg.includes("3-50") || msg.includes("lowercase") || msg.includes("alphanumeric"),
          "Should mention at least one naming rule");
      }
    });
  });
});
