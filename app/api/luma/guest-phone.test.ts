import assert from "node:assert/strict";
import test from "node:test";
import { extractGuestPhoneNumber } from "./guest-phone";

test("uses a direct guest phone number before registration answers", () => {
  assert.equal(
    extractGuestPhoneNumber(
      { phone_number: "+1 415 555 0100" },
      [{ label: "Phone number", value: "+1 415 555 0199" }],
    ),
    "+1 415 555 0100",
  );
});

test("extracts phone numbers from typed registration answers", () => {
  assert.equal(
    extractGuestPhoneNumber({}, [{ questionType: "phone_number", label: "Contact", value: "+1 650 555 0100" }]),
    "+1 650 555 0100",
  );
});

test("extracts phone numbers from clearly labeled registration answers", () => {
  assert.equal(
    extractGuestPhoneNumber({}, [{ questionType: "text", label: "Best mobile number", value: "415-555-0100" }]),
    "415-555-0100",
  );
});

test("does not treat unrelated numeric answers as phone numbers", () => {
  assert.equal(
    extractGuestPhoneNumber({}, [{ questionType: "text", label: "Company size", value: "4155550100" }]),
    "",
  );
});
