import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneVideos } from "../video.js";

function bucketHolding(objects) {
  const stored = new Map(objects.map((o) => [o.key, o]));
  return {
    stored,
    async list() {
      return { objects: [...stored.values()], truncated: false };
    },
    async delete(keys) {
      for (const k of [keys].flat()) stored.delete(k);
    },
  };
}

function copy(key, size, day) {
  return { key, size, uploaded: new Date(`2026-10-${day}T00:00:00Z`) };
}

test("leaves the bucket alone when it is under budget", async () => {
  const bucket = bucketHolding([copy("1.mp4", 40, "01"), copy("2.mp4", 50, "02")]);

  await pruneVideos(bucket, { budgetBytes: 100 });

  assert.deepEqual([...bucket.stored.keys()], ["1.mp4", "2.mp4"]);
});

test("deletes the oldest copies until the bucket is under budget", async () => {
  const bucket = bucketHolding([
    copy("new.mp4", 50, "03"),
    copy("oldest.mp4", 50, "01"),
    copy("older.mp4", 50, "02"),
  ]);

  await pruneVideos(bucket, { budgetBytes: 60 });

  assert.deepEqual([...bucket.stored.keys()], ["new.mp4"]);
});

test("reads every page of the bucket listing", async () => {
  const bucket = bucketHolding([copy("old.mp4", 50, "01"), copy("new.mp4", 50, "02")]);
  bucket.list = async ({ cursor } = {}) =>
    cursor === "page2"
      ? { objects: [bucket.stored.get("old.mp4")], truncated: false }
      : { objects: [bucket.stored.get("new.mp4")], truncated: true, cursor: "page2" };

  await pruneVideos(bucket, { budgetBytes: 60 });

  assert.deepEqual([...bucket.stored.keys()], ["new.mp4"]);
});

test("deletes in batches of at most 1000 keys", async () => {
  const many = Array.from({ length: 1500 }, (_, i) => copy(`${i}.mp4`, 1, "01"));
  const bucket = bucketHolding(many);
  const batches = [];
  const remove = bucket.delete;
  bucket.delete = async (keys) => {
    batches.push(keys.length);
    await remove(keys);
  };

  await pruneVideos(bucket, { budgetBytes: 0 });

  assert.deepEqual(batches, [1000, 500]);
  assert.equal(bucket.stored.size, 0);
});
