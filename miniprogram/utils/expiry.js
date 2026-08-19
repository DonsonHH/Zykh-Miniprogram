const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseDateOnly(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function normalizeExpiryDate(value) {
  const text = String(value || "").trim();
  const monthMatch = text.match(/^(\d{4})-(\d{1,2})$/);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    if (year < 1000 || year > 9999 || month < 1 || month > 12) return "";
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  }

  const dayMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!dayMatch) return "";
  const normalized = `${dayMatch[1]}-${String(dayMatch[2]).padStart(2, "0")}-${String(dayMatch[3]).padStart(2, "0")}`;
  return parseDateOnly(normalized) ? normalized : "";
}

function formatExpiryMonth(value) {
  const normalized = normalizeExpiryDate(value);
  return normalized ? normalized.slice(0, 7) : "";
}

function formatExpiryLabel(value) {
  return normalizeExpiryDate(value);
}

function expiryBoundaryDate(value) {
  const normalized = normalizeExpiryDate(value);
  if (!normalized) return null;
  if (/^\d{4}-\d{2}$/.test(normalized)) {
    const [year, month] = normalized.split("-").map(Number);
    return new Date(year, month, 0);
  }
  return parseDateOnly(normalized);
}

function daysUntil(expireDate, now = new Date()) {
  const expiry = expiryBoundaryDate(expireDate);
  if (!expiry) return null;
  return Math.round((expiry.getTime() - startOfDay(now).getTime()) / DAY_MS);
}

function expiryView(item, now = new Date()) {
  if (!item || !item.name) {
    return {
      expiryClass: "empty",
      expiryText: "空仓",
      expiryHint: "等待录入",
      expiryMonth: "",
      expiryLabel: "",
      expiryDays: null,
      needsAttention: false,
      expiryRank: 5,
    };
  }

  const expiryDays = daysUntil(item.expireDate, now);
  const expiryMonth = formatExpiryMonth(item.expireDate);
  const expiryLabel = formatExpiryLabel(item.expireDate);
  if (expiryDays === null) {
    return {
      expiryClass: "missing",
      expiryText: "未登记效期",
      expiryHint: "请补充有效期",
      expiryMonth: "",
      expiryLabel: "",
      expiryDays: null,
      needsAttention: true,
      expiryRank: 3,
    };
  }
  if (expiryDays < 0) {
    return {
      expiryClass: "expired",
      expiryText: "已过期",
      expiryHint: `已过期 ${Math.abs(expiryDays)} 天`,
      expiryMonth,
      expiryLabel,
      expiryDays,
      needsAttention: true,
      expiryRank: 0,
    };
  }
  if (expiryDays <= 30) {
    return {
      expiryClass: "urgent",
      expiryText: expiryDays === 0 ? "今天到期" : "即将到期",
      expiryHint: expiryDays === 0 ? "请立即处理" : `剩余 ${expiryDays} 天`,
      expiryMonth,
      expiryLabel,
      expiryDays,
      needsAttention: true,
      expiryRank: 1,
    };
  }
  if (expiryDays <= 90) {
    return {
      expiryClass: "soon",
      expiryText: "临期",
      expiryHint: `剩余 ${expiryDays} 天`,
      expiryMonth,
      expiryLabel,
      expiryDays,
      needsAttention: true,
      expiryRank: 2,
    };
  }
  return {
    expiryClass: "valid",
    expiryText: "效期正常",
    expiryHint: `剩余 ${expiryDays} 天`,
    expiryMonth,
    expiryLabel,
    expiryDays,
    needsAttention: false,
    expiryRank: 4,
  };
}

function decorateMedicine(item, now = new Date()) {
  const expireDate = normalizeExpiryDate(item && item.expireDate);
  return Object.assign({}, item, { expireDate }, expiryView(Object.assign({}, item, { expireDate }), now));
}

function summarizeExpiry(items, now = new Date()) {
  const medicines = (items || []).filter(item => item && item.name).map(item => decorateMedicine(item, now));
  const attention = medicines
    .filter(item => item.needsAttention)
    .sort((a, b) => {
      if (a.expiryRank !== b.expiryRank) return a.expiryRank - b.expiryRank;
      if (a.expiryDays === null) return 1;
      if (b.expiryDays === null) return -1;
      return a.expiryDays - b.expiryDays;
    });

  return {
    medicines,
    attention,
    expiredCount: medicines.filter(item => item.expiryClass === "expired").length,
    urgentCount: medicines.filter(item => item.expiryClass === "urgent").length,
    expiringCount: medicines.filter(item => item.expiryClass === "urgent" || item.expiryClass === "soon").length,
    missingCount: medicines.filter(item => item.expiryClass === "missing").length,
    validCount: medicines.filter(item => item.expiryClass === "valid").length,
    nextAttention: attention[0] || null,
  };
}

module.exports = {
  daysUntil,
  decorateMedicine,
  expiryView,
  formatExpiryLabel,
  formatExpiryMonth,
  normalizeExpiryDate,
  parseDateOnly,
  summarizeExpiry,
};
