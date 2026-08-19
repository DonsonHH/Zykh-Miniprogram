const CABINET_SLOT_COUNT = 23;

function isCabinetSlot(value) {
  const slot = Number(value);
  return Number.isInteger(slot) && slot >= 1 && slot <= CABINET_SLOT_COUNT;
}

function clampCabinetSlot(value, fallback = 1) {
  const slot = Number(value);
  if (!Number.isFinite(slot)) return fallback;
  return Math.max(1, Math.min(CABINET_SLOT_COUNT, Math.trunc(slot)));
}

function firstEmptyCabinetSlot(slots = []) {
  const occupied = new Set((slots || [])
    .filter(slot => slot && slot.name && isCabinetSlot(slot.slot))
    .map(slot => Number(slot.slot)));
  for (let slot = 1; slot <= CABINET_SLOT_COUNT; slot += 1) {
    if (!occupied.has(slot)) return slot;
  }
  return 0;
}

module.exports = {
  CABINET_SLOT_COUNT,
  clampCabinetSlot,
  firstEmptyCabinetSlot,
  isCabinetSlot,
};
