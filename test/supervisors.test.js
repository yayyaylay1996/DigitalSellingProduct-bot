import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSupervisorIds, roleFor, canVerify, actorName, decisionLabel } from "../supervisors-lib.js";

test("parseSupervisorIds keeps numeric ids, drops usernames and junk", () => {
  assert.deepEqual(parseSupervisorIds("123456789, 987654321 ,@aye,abc,,123456789"), {
    ids: ["123456789", "987654321"],
    ignored: ["@aye", "abc"],
  });
  assert.deepEqual(parseSupervisorIds(undefined), { ids: [], ignored: [] });
  assert.deepEqual(parseSupervisorIds("12"), { ids: [], ignored: ["12"] }); // too short to be an id
});

test("roleFor: admin anywhere-as-chat, supervisor only in a private chat, others nothing", () => {
  const ctx = { adminId: "111111111", supervisorIds: ["222222222"] };
  assert.equal(roleFor({ ...ctx, chatId: 111111111, chatType: "private" }), "admin");
  assert.equal(roleFor({ ...ctx, chatId: 222222222, chatType: "private" }), "supervisor");
  assert.equal(roleFor({ ...ctx, chatId: 222222222, chatType: "group" }), null);
  assert.equal(roleFor({ ...ctx, chatId: 333333333, chatType: "private" }), null);
  assert.equal(roleFor({ supervisorIds: [], chatId: 5, chatType: "private" }), null);
  // an admin who is also listed stays admin
  assert.equal(roleFor({ adminId: "222222222", supervisorIds: ["222222222"], chatId: 222222222, chatType: "private" }), "admin");
});

test("canVerify: supervisor only on green/yellow, never on red or no verdict; admin always", () => {
  for (const lvl of ["ok", "warn", "bad", "error", ""]) assert.equal(canVerify("admin", lvl), true);
  assert.equal(canVerify("supervisor", "ok"), true);
  assert.equal(canVerify("supervisor", "warn"), true);
  assert.equal(canVerify("supervisor", "bad"), false);
  assert.equal(canVerify("supervisor", "error"), false);
  assert.equal(canVerify("supervisor", ""), false);
  assert.equal(canVerify("supervisor", undefined), false);
  assert.equal(canVerify(null, "ok"), false);
});

test("labels name the supervisor but leave the admin's text as it was", () => {
  const from = { id: 1, first_name: "Aye", last_name: "Aye", username: "aye" };
  assert.equal(actorName(from), "Aye Aye (@aye)");
  assert.equal(actorName({ id: 2, username: "bo" }), "@bo");
  assert.equal(decisionLabel("verify", "admin", from), "Verified");
  assert.equal(decisionLabel("noverify", "admin", from), "No Verify");
  assert.equal(decisionLabel("verify", "supervisor", from), "Verified (by Aye Aye (@aye))");
});

import { parseGroupId, groupRoleFor } from "../supervisors-lib.js";

test("parseGroupId accepts negative numeric group ids only", () => {
  assert.equal(parseGroupId("-1001234567890"), "-1001234567890");
  assert.equal(parseGroupId(" -4012345678 "), "-4012345678");
  assert.equal(parseGroupId("1001234567890"), ""); // positive = a person, not a group
  assert.equal(parseGroupId("@mygroup"), "");
  assert.equal(parseGroupId(undefined), "");
});

test("groupRoleFor: in the group only the admin's own user id counts", () => {
  assert.equal(groupRoleFor({ fromId: 111111111, adminId: "111111111" }), "admin");
  assert.equal(groupRoleFor({ fromId: 222222222, adminId: "111111111" }), null);
  assert.equal(groupRoleFor({ fromId: undefined, adminId: "111111111" }), null);
  assert.equal(groupRoleFor({ fromId: 111111111, adminId: null }), null);
});
