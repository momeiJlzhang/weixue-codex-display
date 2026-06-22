#include "CodexDashboard.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <lvgl.h>
#include <math.h>
#include <stdarg.h>
#include <string.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <BLEDevice.h>
#include "Display_ST77916.h"

LV_FONT_DECLARE(lv_font_codex_cjk_16);
LV_FONT_DECLARE(lv_font_codex_cjk_24);

namespace {

constexpr uint32_t STALE_AFTER_MS = 45000;
constexpr uint32_t DISPLAY_SLEEP_AFTER_MS = 300000;
constexpr uint32_t AUTO_SCHEDULE_HOLD_MS = 120000;
constexpr uint32_t AUTO_IDLE_TO_SCHEDULE_MS = 120000;
constexpr size_t MAX_LINE_LENGTH = 1024;
constexpr int SESSION_ROW_COUNT = 5;
constexpr int DETAIL_ITEM_COUNT = 9;
constexpr int DETAIL_PAGE_COUNT = 3;
constexpr int TAP_DETAIL_PAGE_COUNT = 3;
constexpr int SWIPE_THRESHOLD_PX = 36;
constexpr size_t BLE_RX_QUEUE_BYTES = 1024;
constexpr float EDGE_DOT_RADIANS_PER_DEGREE = 0.01745329252f;
constexpr float EDGE_DOT_RADIUS = 171.0f;
constexpr char BLE_DEVICE_NAME[] = "CodexStatusDisplay";
constexpr char BLE_SERVICE_UUID[] = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
constexpr char BLE_WRITE_CHAR_UUID[] = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";

struct UsageCard {
  lv_obj_t *root;
  lv_obj_t *title;
  lv_obj_t *value;
  lv_obj_t *reset;
  lv_obj_t *note;
};

struct SessionRow {
  lv_obj_t *root;
  lv_obj_t *halo;
  lv_obj_t *dot;
  lv_obj_t *label;
  lv_obj_t *title;
  lv_obj_t *project;
};

struct DetailItem {
  String state;
  String label;
  String title;
  String meta;
};

struct DetailPage {
  String key;
  String title;
  String summary;
  int count = 0;
  bool hasData = false;
  DetailItem items[DETAIL_ITEM_COUNT];
};

struct DashboardUi {
  lv_obj_t *mainPage;
  lv_obj_t *sessionsPage;
  lv_obj_t *touchLayer;
  lv_obj_t *shortArc;
  lv_obj_t *shortTimeDot;
  lv_obj_t *statusPill;
  lv_obj_t *statusHalo;
  lv_obj_t *statusDot;
  lv_obj_t *statusLabel;
  lv_obj_t *footer;
  lv_obj_t *detailTitle;
  lv_obj_t *detailHint;
  lv_obj_t *sessionSummary;
  lv_obj_t *sessionEmpty;
  lv_obj_t *scheduleCurrentCard;
  lv_obj_t *scheduleCurrentLabel;
  lv_obj_t *scheduleCurrentTitle;
  lv_obj_t *scheduleCurrentMeta;
  UsageCard shortCard;
  UsageCard longCard;
  SessionRow sessionRows[SESSION_ROW_COUNT];
};

DashboardUi ui;
String serialLine;
QueueHandle_t bleRxQueue = nullptr;
uint32_t lastUpdateMs = 0;
bool hasData = false;
bool showingDetail = false;
bool showingSchedulePage = false;
int currentDetailIndex = 0;
bool breathing = false;
bool isDisplaySleeping = false;
String lastState = "idle";
String homeHint = "点按查看详情";
bool bleTransportEnabled = true;
lv_point_t touchStartPoint{};
bool touchHasStart = false;
bool touchSuppressClick = false;
int scheduleScrollOffset = 0;
int activeSessionCount = 0;
int lastActiveSessionCount = -1;
uint32_t idleScheduleDueMs = 0;
uint32_t scheduleAutoUntilMs = 0;
String lastCurrentScheduleSignature;
bool hasKnownCurrentSchedule = false;
DetailPage detailPages[DETAIL_PAGE_COUNT];

class BleServerCallbacks : public BLEServerCallbacks {
 public:
  void onConnect(BLEServer* server) override {
    bleTransportEnabled = true;
    Serial.println("[codex-display] ble connected");
  }

  void onDisconnect(BLEServer* server) override {
    bleTransportEnabled = false;
    Serial.println("[codex-display] ble disconnected");
    BLEDevice::startAdvertising();
  }
};

class BleWriteCallbacks : public BLECharacteristicCallbacks {
 public:
  void onWrite(BLECharacteristic* characteristic) override {
    const String value = characteristic->getValue();
    if (value.isEmpty() || bleRxQueue == nullptr) return;
    for (const char ch : value) {
      xQueueSend(bleRxQueue, &ch, 0);
    }
  }
};

lv_style_t screenStyle;
lv_style_t cardStyle;
lv_style_t pillStyle;
lv_style_t rowStyle;
void applyPayload(const String &line);
void initBle();
void renderError(const char *message);
void renderDetailPage();
void parsePageLine(const String &line);
void handleScheduleScroll(lv_dir_t direction);
void openSchedulePage();
void openSessionsPage();
void setScheduleVisible(bool visible);
void handleCodexSessionCount(const char *state, int count, uint32_t nowMs);
void handleAutoPageTick(uint32_t nowMs);

void processIncomingByte(char ch) {
  if (ch == '\r') return;
  if (ch == '\n') {
    if (serialLine.length() > 0) {
      applyPayload(serialLine);
      serialLine = "";
    }
    return;
  }

  if (serialLine.length() < MAX_LINE_LENGTH) {
    serialLine += ch;
  } else {
    serialLine = "";
    renderError("串口数据过长");
  }
}

void initBleRxQueue() {
  if (!bleRxQueue) {
    bleRxQueue = xQueueCreate(BLE_RX_QUEUE_BYTES, sizeof(char));
  }
}

void processBleQueueBytes() {
  if (!bleRxQueue) return;
  char ch;
  while (xQueueReceive(bleRxQueue, &ch, 0) == pdPASS) {
    processIncomingByte(ch);
  }
}

int clampPercent(int value) {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

lv_color_t shortRemainingColor(int remaining) {
  int value = clampPercent(remaining);
  if (value < 20) return lv_color_hex(0xF04438);
  if (value < 50) return lv_color_hex(0xF79009);
  return lv_color_hex(0x12B76A);
}

lv_obj_t *makePage(bool hidden) {
  lv_obj_t *page = lv_obj_create(lv_scr_act());
  lv_obj_remove_style_all(page);
  lv_obj_set_size(page, 360, 360);
  lv_obj_align(page, LV_ALIGN_CENTER, 0, 0);
  lv_obj_clear_flag(page, LV_OBJ_FLAG_SCROLLABLE);
  if (hidden) lv_obj_add_flag(page, LV_OBJ_FLAG_HIDDEN);
  return page;
}

lv_obj_t *makeLabel(lv_obj_t *parent, const char *text, const lv_font_t *font, lv_color_t color) {
  lv_obj_t *label = lv_label_create(parent);
  lv_label_set_text(label, text);
  lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
  lv_obj_set_style_text_color(label, color, LV_PART_MAIN);
  lv_obj_set_style_text_letter_space(label, 0, LV_PART_MAIN);
  return label;
}

void setLabelFmt(lv_obj_t *label, const char *format, ...) {
  char buffer[128];
  va_list args;
  va_start(args, format);
  vsnprintf(buffer, sizeof(buffer), format, args);
  va_end(args);
  lv_label_set_text(label, buffer);
}

const char *jsonString(JsonVariantConst value, const char *fallback) {
  if (value.is<const char *>()) {
    const char *text = value.as<const char *>();
    if (text && *text) return text;
  }
  return fallback;
}

int jsonInt(JsonVariantConst value, int fallback) {
  if (!value.isNull()) return value.as<int>();
  return fallback;
}

JsonVariantConst jsonObject(JsonVariantConst root, const char *longKey, const char *shortKey) {
  JsonVariantConst value = root[longKey];
  if (value.isNull()) value = root[shortKey];
  return value;
}

int detailPageIndexForKey(const String &key) {
  if (key == "schedule") return 0;
  if (key == "sessions") return 1;
  if (key == "health") return 2;
  return -1;
}

void resetDetailPage(int index, const char *key, const char *title, const char *summary) {
  if (index < 0 || index >= DETAIL_PAGE_COUNT) return;
  detailPages[index].key = key;
  detailPages[index].title = title;
  detailPages[index].summary = summary;
  detailPages[index].count = 0;
  detailPages[index].hasData = false;
  for (int i = 0; i < DETAIL_ITEM_COUNT; i += 1) {
    detailPages[index].items[i] = DetailItem{};
  }
}

void setDefaultDetailPages() {
  resetDetailPage(0, "schedule", "飞书日程", "今日无日程 · 明日无日程");
  resetDetailPage(1, "sessions", "会话", "运行 0  待检 0  空闲 0");
  resetDetailPage(2, "health", "健康", "等待桥接状态");
}

String fieldAt(const String &text, int fieldIndex, char delimiter) {
  int start = 0;
  for (int i = 0; i < fieldIndex; i += 1) {
    int next = text.indexOf(delimiter, start);
    if (next < 0) return "";
    start = next + 1;
  }
  int end = text.indexOf(delimiter, start);
  if (end < 0) return text.substring(start);
  return text.substring(start, end);
}

void initEdgeProgressArc() {
  ui.shortArc = lv_arc_create(lv_scr_act());
  lv_obj_set_size(ui.shortArc, 360, 360);
  lv_obj_center(ui.shortArc);
  lv_arc_set_range(ui.shortArc, 0, 100);
  lv_arc_set_rotation(ui.shortArc, 270);
  lv_arc_set_bg_angles(ui.shortArc, 0, 360);
  lv_arc_set_value(ui.shortArc, 0);
  lv_obj_remove_style(ui.shortArc, nullptr, LV_PART_KNOB);
  lv_obj_clear_flag(ui.shortArc, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_arc_width(ui.shortArc, 5, LV_PART_MAIN);
  lv_obj_set_style_arc_width(ui.shortArc, 5, LV_PART_INDICATOR);
  lv_obj_set_style_arc_color(ui.shortArc, lv_color_hex(0xDCE6F2), LV_PART_MAIN);
  lv_obj_set_style_arc_color(ui.shortArc, lv_color_hex(0x12B76A), LV_PART_INDICATOR);
  lv_obj_set_style_arc_rounded(ui.shortArc, true, LV_PART_MAIN);
  lv_obj_set_style_arc_rounded(ui.shortArc, true, LV_PART_INDICATOR);
  lv_obj_set_style_arc_opa(ui.shortArc, LV_OPA_70, LV_PART_MAIN);
  lv_obj_set_style_arc_opa(ui.shortArc, LV_OPA_COVER, LV_PART_INDICATOR);

  ui.shortTimeDot = lv_obj_create(lv_scr_act());
  lv_obj_remove_style_all(ui.shortTimeDot);
  lv_obj_set_size(ui.shortTimeDot, 12, 12);
  lv_obj_set_style_radius(ui.shortTimeDot, LV_RADIUS_CIRCLE, LV_PART_MAIN);
  lv_obj_set_style_bg_color(ui.shortTimeDot, lv_color_hex(0xFFFFFF), LV_PART_MAIN);
  lv_obj_set_style_bg_opa(ui.shortTimeDot, LV_OPA_COVER, LV_PART_MAIN);
  lv_obj_set_style_border_width(ui.shortTimeDot, 3, LV_PART_MAIN);
  lv_obj_set_style_border_color(ui.shortTimeDot, lv_color_hex(0x12B76A), LV_PART_MAIN);
  lv_obj_set_style_shadow_width(ui.shortTimeDot, 6, LV_PART_MAIN);
  lv_obj_set_style_shadow_opa(ui.shortTimeDot, LV_OPA_20, LV_PART_MAIN);
  lv_obj_set_style_shadow_color(ui.shortTimeDot, lv_color_hex(0x101828), LV_PART_MAIN);
  lv_obj_clear_flag(ui.shortTimeDot, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_clear_flag(ui.shortTimeDot, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_add_flag(ui.shortTimeDot, LV_OBJ_FLAG_HIDDEN);
}

void positionShortTimeDot(int timeRemainingPercent, lv_color_t color) {
  if (!ui.shortTimeDot) return;

  int value = clampPercent(timeRemainingPercent);
  float angle = (270.0f + static_cast<float>(value) * 3.6f) * EDGE_DOT_RADIANS_PER_DEGREE;
  int offsetX = static_cast<int>(roundf(cosf(angle) * EDGE_DOT_RADIUS));
  int offsetY = static_cast<int>(roundf(sinf(angle) * EDGE_DOT_RADIUS));

  lv_obj_set_style_border_color(ui.shortTimeDot, color, LV_PART_MAIN);
  lv_obj_align(ui.shortTimeDot, LV_ALIGN_CENTER, offsetX, offsetY);
  lv_obj_clear_flag(ui.shortTimeDot, LV_OBJ_FLAG_HIDDEN);
}

void updateEdgeProgress(int remainingPercent, int timeRemainingPercent) {
  int remainingValue = clampPercent(remainingPercent);
  lv_color_t color = shortRemainingColor(remainingValue);
  if (ui.shortArc) {
    lv_arc_set_value(ui.shortArc, remainingValue);
    lv_obj_set_style_arc_color(ui.shortArc, color, LV_PART_INDICATOR);
  }
  positionShortTimeDot(timeRemainingPercent, color);
}

UsageCard makeUsageCard(lv_obj_t *parent, int y, const char *title, lv_color_t accent) {
  UsageCard card{};
  card.root = lv_obj_create(parent);
  lv_obj_add_style(card.root, &cardStyle, LV_PART_MAIN);
  lv_obj_set_size(card.root, 278, 86);
  lv_obj_align(card.root, LV_ALIGN_TOP_MID, 0, y);
  lv_obj_clear_flag(card.root, LV_OBJ_FLAG_SCROLLABLE);

  card.value = makeLabel(card.root, "--%", &lv_font_montserrat_48, accent);
  lv_obj_align(card.value, LV_ALIGN_LEFT_MID, 0, 8);

  card.title = makeLabel(card.root, title, &lv_font_codex_cjk_16, lv_color_hex(0x344054));
  lv_obj_set_width(card.title, 118);
  lv_obj_set_style_text_align(card.title, LV_TEXT_ALIGN_RIGHT, LV_PART_MAIN);
  lv_obj_align(card.title, LV_ALIGN_TOP_RIGHT, 0, -2);

  card.reset = makeLabel(card.root, "重置 --", &lv_font_codex_cjk_16, accent);
  lv_obj_set_width(card.reset, 118);
  lv_obj_set_style_text_align(card.reset, LV_TEXT_ALIGN_RIGHT, LV_PART_MAIN);
  lv_label_set_long_mode(card.reset, LV_LABEL_LONG_DOT);
  lv_obj_align(card.reset, LV_ALIGN_RIGHT_MID, 0, 2);

  card.note = makeLabel(card.root, "剩余 --", &lv_font_codex_cjk_16, lv_color_hex(0x98A2B3));
  lv_obj_set_width(card.note, 118);
  lv_obj_set_style_text_align(card.note, LV_TEXT_ALIGN_RIGHT, LV_PART_MAIN);
  lv_label_set_long_mode(card.note, LV_LABEL_LONG_DOT);
  lv_obj_align(card.note, LV_ALIGN_BOTTOM_RIGHT, 0, 4);

  return card;
}

lv_color_t stateColor(const char *state) {
  if (strcmp(state, "done") == 0) return lv_color_hex(0x12B76A);
  if (strcmp(state, "working") == 0 || strcmp(state, "work") == 0) return lv_color_hex(0x12B76A);
  if (strcmp(state, "waiting") == 0 || strcmp(state, "check") == 0) return lv_color_hex(0xF79009);
  if (strcmp(state, "error") == 0) return lv_color_hex(0xF04438);
  if (strcmp(state, "stale") == 0) return lv_color_hex(0x667085);
  return lv_color_hex(0x2F80ED);
}

void breatheExec(void *obj, int32_t value) {
  lv_obj_t *halo = static_cast<lv_obj_t *>(obj);
  uint8_t opa = 120;
  if (value > 18) opa = static_cast<uint8_t>(120 - ((value - 18) * 5));
  lv_obj_set_size(halo, value, value);
  lv_obj_set_style_bg_opa(halo, opa, LV_PART_MAIN);
  lv_obj_align_to(halo, ui.statusDot, LV_ALIGN_CENTER, 0, 0);
}

void rowBreatheExec(void *obj, int32_t value) {
  lv_obj_t *halo = static_cast<lv_obj_t *>(obj);
  uint8_t opa = 105;
  if (value > 12) opa = static_cast<uint8_t>(105 - ((value - 12) * 6));
  lv_obj_set_size(halo, value, value);
  lv_obj_set_style_bg_opa(halo, opa, LV_PART_MAIN);
  lv_obj_align(halo, LV_ALIGN_TOP_LEFT, 6 - (value / 2), 12 - (value / 2));
}

void startBreathing() {
  if (breathing) return;
  breathing = true;
  lv_obj_clear_flag(ui.statusHalo, LV_OBJ_FLAG_HIDDEN);

  lv_anim_t anim;
  lv_anim_init(&anim);
  lv_anim_set_var(&anim, ui.statusHalo);
  lv_anim_set_exec_cb(&anim, breatheExec);
  lv_anim_set_values(&anim, 18, 34);
  lv_anim_set_time(&anim, 900);
  lv_anim_set_playback_time(&anim, 900);
  lv_anim_set_repeat_count(&anim, LV_ANIM_REPEAT_INFINITE);
  lv_anim_start(&anim);
}

void stopBreathing() {
  if (!breathing) return;
  breathing = false;
  lv_anim_del(ui.statusHalo, breatheExec);
  lv_obj_set_size(ui.statusHalo, 18, 18);
  lv_obj_add_flag(ui.statusHalo, LV_OBJ_FLAG_HIDDEN);
}

void setDisplaySleeping(bool sleeping) {
  if (isDisplaySleeping == sleeping) return;
  isDisplaySleeping = sleeping;

  if (sleeping) {
    Set_Backlight(0);
    return;
  }

  Set_Backlight(LCD_Backlight);
}

void wakeDisplay() {
  setDisplaySleeping(false);
}

void initBle() {
  initBleRxQueue();

  BLEDevice::init(BLE_DEVICE_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new BleServerCallbacks());

  BLEService *service = server->createService(BLE_SERVICE_UUID);
  BLECharacteristic *rxCharacteristic = service->createCharacteristic(
    BLE_WRITE_CHAR_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  rxCharacteristic->setCallbacks(new BleWriteCallbacks());
  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
  Serial.printf("[codex-display] BLE ready: %s\n", BLE_SERVICE_UUID);
}

void setRowBreathing(SessionRow &row, bool active, lv_color_t color) {
  lv_anim_del(row.halo, rowBreatheExec);
  lv_obj_set_style_bg_color(row.halo, color, LV_PART_MAIN);
  if (!active) {
    lv_obj_set_size(row.halo, 12, 12);
    lv_obj_add_flag(row.halo, LV_OBJ_FLAG_HIDDEN);
    return;
  }

  lv_obj_clear_flag(row.halo, LV_OBJ_FLAG_HIDDEN);
  lv_anim_t anim;
  lv_anim_init(&anim);
  lv_anim_set_var(&anim, row.halo);
  lv_anim_set_exec_cb(&anim, rowBreatheExec);
  lv_anim_set_values(&anim, 12, 26);
  lv_anim_set_time(&anim, 850);
  lv_anim_set_playback_time(&anim, 850);
  lv_anim_set_repeat_count(&anim, LV_ANIM_REPEAT_INFINITE);
  lv_anim_start(&anim);
}

void setStatusVisual(const char *state, int count = -1, const char *overrideLabel = nullptr) {
  lv_color_t color = stateColor(state);
  const char *label = "空闲";

  if (strcmp(state, "working") == 0) label = "运行中";
  else if (strcmp(state, "waiting") == 0) label = "需要处理";
  else if (strcmp(state, "error") == 0) label = "异常";
  else if (strcmp(state, "stale") == 0) label = "离线";
  if (overrideLabel && *overrideLabel) label = overrideLabel;

  char statusText[32];
  if (count >= 0 && strcmp(state, "idle") != 0 && strcmp(state, "stale") != 0) {
    snprintf(statusText, sizeof(statusText), "%s %d", label, count);
  } else {
    snprintf(statusText, sizeof(statusText), "%s", label);
  }

  lastState = state;
  lv_obj_set_style_bg_color(ui.statusHalo, color, LV_PART_MAIN);
  lv_obj_set_style_bg_color(ui.statusDot, color, LV_PART_MAIN);
  lv_obj_set_style_border_color(ui.statusPill, color, LV_PART_MAIN);
  lv_obj_set_style_text_color(ui.statusLabel, color, LV_PART_MAIN);
  lv_label_set_text(ui.statusLabel, statusText);

  if (strcmp(state, "working") == 0 || strcmp(state, "waiting") == 0) startBreathing();
  else stopBreathing();
}

void updateCard(UsageCard &card, int remaining, const char *reset, const char *resetRemaining) {
  int value = clampPercent(remaining);
  setLabelFmt(card.value, "%d%%", value);
  setLabelFmt(card.reset, "重置 %s", reset && *reset ? reset : "--");
  setLabelFmt(card.note, "剩余 %s", resetRemaining && *resetRemaining ? resetRemaining : "--");
}

void makeScheduleCurrentCard(lv_obj_t *parent) {
  ui.scheduleCurrentCard = lv_obj_create(parent);
  lv_obj_add_style(ui.scheduleCurrentCard, &cardStyle, LV_PART_MAIN);
  lv_obj_set_size(ui.scheduleCurrentCard, 282, 88);
  lv_obj_align(ui.scheduleCurrentCard, LV_ALIGN_TOP_MID, 0, 100);
  lv_obj_clear_flag(ui.scheduleCurrentCard, LV_OBJ_FLAG_SCROLLABLE);

  ui.scheduleCurrentLabel = makeLabel(ui.scheduleCurrentCard, "当前日程", &lv_font_codex_cjk_16, lv_color_hex(0x12B76A));
  lv_obj_align(ui.scheduleCurrentLabel, LV_ALIGN_TOP_LEFT, 0, -2);

  ui.scheduleCurrentMeta = makeLabel(ui.scheduleCurrentCard, "--", &lv_font_codex_cjk_16, lv_color_hex(0x667085));
  lv_obj_set_width(ui.scheduleCurrentMeta, 110);
  lv_obj_set_style_text_align(ui.scheduleCurrentMeta, LV_TEXT_ALIGN_RIGHT, LV_PART_MAIN);
  lv_label_set_long_mode(ui.scheduleCurrentMeta, LV_LABEL_LONG_DOT);
  lv_obj_align(ui.scheduleCurrentMeta, LV_ALIGN_TOP_RIGHT, 0, -2);

  ui.scheduleCurrentTitle = makeLabel(ui.scheduleCurrentCard, "--", &lv_font_codex_cjk_24, lv_color_hex(0x101828));
  lv_obj_set_width(ui.scheduleCurrentTitle, 258);
  lv_obj_set_style_text_align(ui.scheduleCurrentTitle, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
  lv_label_set_long_mode(ui.scheduleCurrentTitle, LV_LABEL_LONG_DOT);
  lv_obj_align(ui.scheduleCurrentTitle, LV_ALIGN_CENTER, 0, 14);
  lv_obj_add_flag(ui.scheduleCurrentCard, LV_OBJ_FLAG_HIDDEN);
}

void hideScheduleCurrentCard() {
  if (ui.scheduleCurrentCard) lv_obj_add_flag(ui.scheduleCurrentCard, LV_OBJ_FLAG_HIDDEN);
}

void showScheduleCurrentCard(const DetailItem &item) {
  if (!ui.scheduleCurrentCard) return;
  lv_obj_clear_flag(ui.scheduleCurrentCard, LV_OBJ_FLAG_HIDDEN);
  lv_label_set_text(ui.scheduleCurrentLabel, item.label == "即将" ? "即将开始" : "当前日程");
  lv_label_set_text(ui.scheduleCurrentTitle, item.title.c_str());
  lv_label_set_text(ui.scheduleCurrentMeta, item.meta.c_str());
}

void applyRowLayout(SessionRow &row, bool wideLabel) {
  lv_obj_set_width(row.label, wideLabel ? 86 : 64);
  lv_obj_align(row.label, LV_ALIGN_TOP_LEFT, 20, 2);
  lv_obj_set_width(row.title, wideLabel ? 152 : 172);
  lv_obj_align(row.title, LV_ALIGN_TOP_LEFT, wideLabel ? 112 : 92, 2);
  lv_obj_set_width(row.project, wideLabel ? 152 : 172);
  lv_obj_align(row.project, LV_ALIGN_TOP_LEFT, wideLabel ? 112 : 92, 22);
}

SessionRow makeSessionRow(lv_obj_t *parent, int y) {
  SessionRow row{};
  row.root = lv_obj_create(parent);
  lv_obj_add_style(row.root, &rowStyle, LV_PART_MAIN);
  lv_obj_set_size(row.root, 282, 42);
  lv_obj_align(row.root, LV_ALIGN_TOP_MID, 0, y);
  lv_obj_clear_flag(row.root, LV_OBJ_FLAG_SCROLLABLE);

  row.halo = lv_obj_create(row.root);
  lv_obj_set_size(row.halo, 12, 12);
  lv_obj_set_style_radius(row.halo, LV_RADIUS_CIRCLE, LV_PART_MAIN);
  lv_obj_set_style_border_width(row.halo, 0, LV_PART_MAIN);
  lv_obj_add_flag(row.halo, LV_OBJ_FLAG_HIDDEN);
  lv_obj_align(row.halo, LV_ALIGN_TOP_LEFT, 0, 6);

  row.dot = lv_obj_create(row.root);
  lv_obj_set_size(row.dot, 12, 12);
  lv_obj_set_style_radius(row.dot, LV_RADIUS_CIRCLE, LV_PART_MAIN);
  lv_obj_set_style_border_width(row.dot, 0, LV_PART_MAIN);
  lv_obj_align(row.dot, LV_ALIGN_TOP_LEFT, 0, 6);

  row.label = makeLabel(row.root, "空闲", &lv_font_codex_cjk_16, lv_color_hex(0x344054));
  lv_label_set_long_mode(row.label, LV_LABEL_LONG_DOT);

  row.title = makeLabel(row.root, "--", &lv_font_codex_cjk_16, lv_color_hex(0x101828));
  lv_label_set_long_mode(row.title, LV_LABEL_LONG_DOT);

  row.project = makeLabel(row.root, "项目", &lv_font_codex_cjk_16, lv_color_hex(0x667085));
  lv_label_set_long_mode(row.project, LV_LABEL_LONG_DOT);
  applyRowLayout(row, false);

  lv_obj_add_flag(row.root, LV_OBJ_FLAG_HIDDEN);
  return row;
}

void showSessionRow(int index, const char *state, const char *label, const char *title, const char *project, const char *age) {
  if (index < 0 || index >= SESSION_ROW_COUNT) return;
  SessionRow &row = ui.sessionRows[index];
  lv_color_t color = stateColor(state);
  applyRowLayout(row, label && strchr(label, ':') != nullptr);
  lv_obj_clear_flag(row.root, LV_OBJ_FLAG_HIDDEN);
  lv_obj_set_style_bg_color(row.dot, color, LV_PART_MAIN);
  lv_obj_set_style_text_color(row.label, color, LV_PART_MAIN);
  lv_label_set_text(row.label, label && *label ? label : "空闲");
  lv_label_set_text(row.title, title && *title ? title : "--");
  String meta = project && *project ? String(project) : String("项目");
  if (age && *age) {
    meta += " ";
    meta += age;
  }
  lv_label_set_text(row.project, meta.c_str());
  setRowBreathing(row, strcmp(state, "work") == 0, color);
}

void finishSessionRows(int visibleCount) {
  for (int i = visibleCount; i < SESSION_ROW_COUNT; i += 1) {
    setRowBreathing(ui.sessionRows[i], false, lv_color_hex(0x2F80ED));
    lv_obj_add_flag(ui.sessionRows[i].root, LV_OBJ_FLAG_HIDDEN);
  }

  if (visibleCount == 0) lv_obj_clear_flag(ui.sessionEmpty, LV_OBJ_FLAG_HIDDEN);
  else lv_obj_add_flag(ui.sessionEmpty, LV_OBJ_FLAG_HIDDEN);
}

bool isScheduleTimeMeta(const String &meta) {
  return meta.indexOf(':') >= 0;
}

bool isCurrentSchedulePage() {
  return showingDetail
    && currentDetailIndex >= 0
    && currentDetailIndex < DETAIL_PAGE_COUNT
    && detailPages[currentDetailIndex].key == "schedule";
}

int scheduleVisibleRowLimit(bool hasCurrentSchedule) {
  return hasCurrentSchedule ? 4 : SESSION_ROW_COUNT;
}

bool isFeaturedScheduleItem(const DetailItem &item) {
  return item.label == "当前" || item.label == "即将";
}

bool timerReached(uint32_t nowMs, uint32_t targetMs) {
  return targetMs != 0 && static_cast<int32_t>(nowMs - targetMs) >= 0;
}

void renderDetailPage() {
  if (!ui.detailTitle || !ui.detailHint) return;
  if (currentDetailIndex < 0 || currentDetailIndex >= DETAIL_PAGE_COUNT) currentDetailIndex = 0;

  DetailPage &page = detailPages[currentDetailIndex];
  bool isSchedulePage = page.key == "schedule";
  lv_label_set_text(ui.detailTitle, page.title.c_str());
  if (isSchedulePage) {
    lv_label_set_text(ui.detailHint, page.summary.c_str());
  } else {
    setLabelFmt(ui.detailHint, "点按下一页 %d/%d", currentDetailIndex + 1, TAP_DETAIL_PAGE_COUNT);
  }
  if (isSchedulePage) {
    lv_obj_add_flag(ui.sessionSummary, LV_OBJ_FLAG_HIDDEN);
  } else {
    lv_obj_clear_flag(ui.sessionSummary, LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text(ui.sessionSummary, page.summary.c_str());
  }
  if (page.key == "sessions") {
    lv_label_set_text(ui.sessionEmpty, "暂无会话");
  } else if (isSchedulePage) {
    lv_label_set_text(ui.sessionEmpty, "暂无日程");
  } else {
    lv_label_set_text(ui.sessionEmpty, "暂无详情");
  }

  int visibleCount = 0;
  int listStartIndex = 0;
  bool hasFeaturedSchedule = isSchedulePage
    && page.count > 0
    && isFeaturedScheduleItem(page.items[0]);
  int visibleLimit = isSchedulePage ? scheduleVisibleRowLimit(hasFeaturedSchedule) : SESSION_ROW_COUNT;

  if (hasFeaturedSchedule) {
    lv_obj_align(ui.scheduleCurrentCard, LV_ALIGN_TOP_MID, 0, 84);
    showScheduleCurrentCard(page.items[0]);
    listStartIndex = 1;
  } else {
    hideScheduleCurrentCard();
  }

  if (isSchedulePage) {
    int maxOffset = page.count - listStartIndex - visibleLimit;
    if (maxOffset < 0) maxOffset = 0;
    if (scheduleScrollOffset > maxOffset) scheduleScrollOffset = maxOffset;
    if (scheduleScrollOffset < 0) scheduleScrollOffset = 0;
  }

  int startIndex = listStartIndex + (isSchedulePage ? scheduleScrollOffset : 0);
  for (int i = startIndex; i < page.count && visibleCount < visibleLimit; i += 1) {
    DetailItem &item = page.items[i];
    int rowY = hasFeaturedSchedule ? (184 + visibleCount * 42) : (104 + visibleCount * 42);
    String itemLabel = isSchedulePage && isScheduleTimeMeta(item.meta) ? item.meta : item.label;
    String itemMeta = isSchedulePage && isScheduleTimeMeta(item.meta) ? item.label : item.meta;
    lv_obj_align(ui.sessionRows[visibleCount].root, LV_ALIGN_TOP_MID, 0, rowY);
    showSessionRow(
      visibleCount,
      item.state.c_str(),
      itemLabel.c_str(),
      item.title.c_str(),
      itemMeta.c_str(),
      ""
    );
    visibleCount += 1;
  }
  finishSessionRows(visibleCount);
}

String currentScheduleSignature(const DetailPage &page) {
  for (int i = 0; i < page.count; i += 1) {
    const DetailItem &item = page.items[i];
    if (item.label == "当前") {
      String signature = item.title;
      signature += "|";
      signature += item.meta;
      return signature;
    }
  }
  return "";
}

void handleCurrentScheduleChange(DetailPage &page, uint32_t nowMs) {
  String signature = currentScheduleSignature(page);
  bool changed = hasKnownCurrentSchedule
    && signature != lastCurrentScheduleSignature;

  lastCurrentScheduleSignature = signature;
  hasKnownCurrentSchedule = true;

  if (!changed) return;
  scheduleAutoUntilMs = nowMs + AUTO_SCHEDULE_HOLD_MS;
  idleScheduleDueMs = 0;
  openSchedulePage();
}

void parsePageLine(const String &line) {
  int first = line.indexOf('|');
  int second = line.indexOf('|', first + 1);
  int third = line.indexOf('|', second + 1);
  if (first < 0 || second < 0 || third < 0) return;

  String key = line.substring(first + 1, second);
  int index = detailPageIndexForKey(key);
  if (index < 0) return;

  DetailPage &page = detailPages[index];
  page.key = key;
  int fourth = line.indexOf('|', third + 1);
  page.title = line.substring(second + 1, third);
  page.summary = fourth < 0 ? line.substring(third + 1) : line.substring(third + 1, fourth);
  page.count = 0;
  page.hasData = true;
  for (int i = 0; i < DETAIL_ITEM_COUNT; i += 1) {
    page.items[i] = DetailItem{};
  }

  int pos = fourth < 0 ? -1 : fourth + 1;
  while (pos >= 0 && pos < static_cast<int>(line.length()) && page.count < DETAIL_ITEM_COUNT) {
    int next = line.indexOf('|', pos);
    String segment = next < 0 ? line.substring(pos) : line.substring(pos, next);
    if (segment.length() > 0) {
      DetailItem &item = page.items[page.count];
      item.state = fieldAt(segment, 0, ',');
      item.label = fieldAt(segment, 1, ',');
      item.title = fieldAt(segment, 2, ',');
      item.meta = fieldAt(segment, 3, ',');
      page.count += 1;
    }
    if (next < 0) break;
    pos = next + 1;
  }

  if (key == "schedule") {
    if (!isCurrentSchedulePage()) {
      scheduleScrollOffset = 0;
    }
    handleCurrentScheduleChange(page, millis());
  }
  if (showingDetail && currentDetailIndex == index) renderDetailPage();
}

void renderSessionLine(const String &line) {
  int first = line.indexOf('|');
  int second = line.indexOf('|', first + 1);
  if (first < 0) return;

  String countsText = second < 0 ? line.substring(first + 1) : line.substring(first + 1, second);
  int work = 0;
  int check = 0;
  int idle = 0;
  int error = 0;
  sscanf(countsText.c_str(), "%d,%d,%d,%d", &work, &check, &idle, &error);
  int pageIndex = detailPageIndexForKey("sessions");
  if (pageIndex < 0) return;
  DetailPage &page = detailPages[pageIndex];
  page.key = "sessions";
  page.title = "会话";
  page.summary = "";
  page.count = 0;
  page.hasData = true;
  char summary[64];
  snprintf(summary, sizeof(summary), "运行 %d  待检 %d  空闲 %d", work, check, idle + error);
  page.summary = summary;
  for (int i = 0; i < DETAIL_ITEM_COUNT; i += 1) {
    page.items[i] = DetailItem{};
  }

  int index = 0;
  int pos = second < 0 ? -1 : second + 1;
  while (pos >= 0 && pos < static_cast<int>(line.length()) && index < DETAIL_ITEM_COUNT) {
    int next = line.indexOf('|', pos);
    String segment = next < 0 ? line.substring(pos) : line.substring(pos, next);
    int comma1 = segment.indexOf(',');
    int comma2 = segment.indexOf(',', comma1 + 1);
    int comma3 = segment.indexOf(',', comma2 + 1);
    int comma4 = segment.indexOf(',', comma3 + 1);
    if (comma1 > 0 && comma2 > comma1) {
      String state = segment.substring(0, comma1);
      String label = segment.substring(comma1 + 1, comma2);
      String title = comma3 > comma2 ? segment.substring(comma2 + 1, comma3) : segment.substring(comma2 + 1);
      String project = comma3 > comma2 ? (comma4 > comma3 ? segment.substring(comma3 + 1, comma4) : segment.substring(comma3 + 1)) : "项目";
      String age = comma4 > comma3 ? segment.substring(comma4 + 1) : "";
      DetailItem &item = page.items[index];
      item.state = state;
      item.label = label;
      item.title = title;
      item.meta = project;
      if (age.length() > 0) {
        item.meta += " ";
        item.meta += age;
      }
      index += 1;
    }
    if (next < 0) break;
    pos = next + 1;
  }

  page.count = index;
  if (showingDetail && currentDetailIndex == pageIndex) renderDetailPage();
}

void renderWaiting() {
  lv_label_set_text(ui.shortCard.value, "--%");
  lv_label_set_text(ui.longCard.value, "--%");
  lv_label_set_text(ui.shortCard.reset, "重置 --");
  lv_label_set_text(ui.longCard.reset, "重置 --");
  lv_label_set_text(ui.shortCard.note, "剩余 --");
  lv_label_set_text(ui.longCard.note, "剩余 --");
  updateEdgeProgress(100, 0);
  if (ui.shortTimeDot) lv_obj_add_flag(ui.shortTimeDot, LV_OBJ_FLAG_HIDDEN);
  setStatusVisual("idle");
  homeHint = "点按查看详情";
  lv_label_set_text(ui.footer, homeHint.c_str());
}

void renderError(const char *message) {
  setStatusVisual("error");
  lv_label_set_text(ui.footer, message && *message ? message : "桥接异常");
}

void setDetailVisible(bool visible) {
  showingDetail = visible;
  showingSchedulePage = false;
  if (visible && isCurrentSchedulePage()) scheduleScrollOffset = 0;
  if (visible) {
    lv_obj_add_flag(ui.mainPage, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(ui.sessionsPage, LV_OBJ_FLAG_HIDDEN);
    renderDetailPage();
  } else {
    lv_obj_clear_flag(ui.mainPage, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(ui.sessionsPage, LV_OBJ_FLAG_HIDDEN);
  }
}

void setScheduleVisible(bool visible) {
  if (visible) {
    currentDetailIndex = detailPageIndexForKey("schedule");
    scheduleScrollOffset = 0;
    setDetailVisible(true);
  } else {
    setDetailVisible(false);
  }
}

void openSessionsPage() {
  currentDetailIndex = detailPageIndexForKey("sessions");
  setDetailVisible(true);
}

void openSchedulePage() {
  currentDetailIndex = detailPageIndexForKey("schedule");
  scheduleScrollOffset = 0;
  setDetailVisible(true);
}

void returnToMainPage() {
  showingDetail = false;
  showingSchedulePage = false;
  lv_obj_clear_flag(ui.mainPage, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(ui.sessionsPage, LV_OBJ_FLAG_HIDDEN);
}

int activeCountFromStatus(const char *state, int count) {
  if (strcmp(state, "working") != 0 && strcmp(state, "waiting") != 0) return 0;
  return count > 0 ? count : 1;
}

void handleCodexSessionCount(const char *state, int count, uint32_t nowMs) {
  int activeCount = activeCountFromStatus(state, count);
  activeSessionCount = activeCount;

  if (lastActiveSessionCount < 0) {
    lastActiveSessionCount = activeCount;
    if (activeCount == 0) {
      idleScheduleDueMs = nowMs + AUTO_IDLE_TO_SCHEDULE_MS;
    }
    return;
  }

  if (lastActiveSessionCount == 0 && activeCount > 0) {
    idleScheduleDueMs = 0;
    scheduleAutoUntilMs = 0;
  } else if (lastActiveSessionCount > 0 && activeCount == 0) {
    idleScheduleDueMs = nowMs + AUTO_IDLE_TO_SCHEDULE_MS;
  } else if (activeCount > 0) {
    idleScheduleDueMs = 0;
  }

  lastActiveSessionCount = activeCount;
}

void handleAutoPageTick(uint32_t nowMs) {
  if (timerReached(nowMs, scheduleAutoUntilMs)) {
    scheduleAutoUntilMs = 0;
  }

  if (activeSessionCount == 0 && timerReached(nowMs, idleScheduleDueMs)) {
    idleScheduleDueMs = 0;
    openSchedulePage();
  }
}

void handleSwipeDirection(lv_dir_t direction) {
  if (direction == LV_DIR_LEFT) {
    openSchedulePage();
    return;
  }

  if (direction == LV_DIR_RIGHT && showingDetail) {
    returnToMainPage();
    return;
  }

  if ((direction == LV_DIR_TOP || direction == LV_DIR_BOTTOM) && isCurrentSchedulePage()) {
    handleScheduleScroll(direction);
  }
}

void handleScheduleScroll(lv_dir_t direction) {
  DetailPage &page = detailPages[currentDetailIndex];
  bool hasFeaturedSchedule = page.count > 0 && isFeaturedScheduleItem(page.items[0]);
  int listStartIndex = hasFeaturedSchedule ? 1 : 0;
  int visibleLimit = scheduleVisibleRowLimit(hasFeaturedSchedule);
  int maxOffset = page.count - listStartIndex - visibleLimit;
  if (maxOffset < 0) maxOffset = 0;

  if (direction == LV_DIR_TOP && scheduleScrollOffset < maxOffset) {
    scheduleScrollOffset += 1;
    renderDetailPage();
    return;
  }

  if (direction == LV_DIR_BOTTOM && scheduleScrollOffset > 0) {
    scheduleScrollOffset -= 1;
    renderDetailPage();
  }
}

void storeTouchStart() {
  lv_indev_t *indev = lv_indev_get_act();
  if (!indev) return;
  lv_indev_get_point(indev, &touchStartPoint);
  touchHasStart = true;
  touchSuppressClick = false;
}

void handleSwipeRelease() {
  lv_indev_t *indev = lv_indev_get_act();
  if (!indev || !touchHasStart) return;

  lv_point_t currentPoint{};
  lv_indev_get_point(indev, &currentPoint);
  touchHasStart = false;

  int dx = currentPoint.x - touchStartPoint.x;
  int dy = currentPoint.y - touchStartPoint.y;
  int absDx = dx < 0 ? -dx : dx;
  int absDy = dy < 0 ? -dy : dy;
  if (absDy >= SWIPE_THRESHOLD_PX && absDy > absDx) {
    touchSuppressClick = true;
    if (isDisplaySleeping) {
      wakeDisplay();
      return;
    }
    handleSwipeDirection(dy < 0 ? LV_DIR_TOP : LV_DIR_BOTTOM);
    return;
  }

  if (absDx < SWIPE_THRESHOLD_PX || absDx <= absDy) return;

  touchSuppressClick = true;
  if (isDisplaySleeping) {
    wakeDisplay();
    return;
  }

  handleSwipeDirection(dx < 0 ? LV_DIR_LEFT : LV_DIR_RIGHT);
}

void touchEvent(lv_event_t *event) {
  lv_event_code_t code = lv_event_get_code(event);
  if (code == LV_EVENT_PRESSED) {
    storeTouchStart();
    return;
  }

  if (code == LV_EVENT_RELEASED) {
    handleSwipeRelease();
    return;
  }

  if (code == LV_EVENT_GESTURE) {
    touchSuppressClick = true;
    if (isDisplaySleeping) {
      wakeDisplay();
      return;
    }

    lv_indev_t *indev = lv_indev_get_act();
    if (!indev) return;
    handleSwipeDirection(lv_indev_get_gesture_dir(indev));
    return;
  }

  if (code == LV_EVENT_CLICKED) {
    if (touchSuppressClick) {
      touchSuppressClick = false;
      return;
    }

    if (isDisplaySleeping) {
      wakeDisplay();
      return;
    }
    if (!showingDetail) {
      currentDetailIndex = detailPageIndexForKey("schedule");
      setDetailVisible(true);
      return;
    }
    currentDetailIndex += 1;
    if (currentDetailIndex >= TAP_DETAIL_PAGE_COUNT) {
      setDetailVisible(false);
      return;
    }
    renderDetailPage();
  }
}

void applyPayload(const String &line) {
  if (isDisplaySleeping) {
    wakeDisplay();
  }

  if (line.startsWith("PAGE|")) {
    parsePageLine(line);
    Serial.println("[codex-display] page applied");
    return;
  }

  if (line.startsWith("SESS|")) {
    renderSessionLine(line);
    Serial.println("[codex-display] sessions applied");
    return;
  }

  DynamicJsonDocument doc(4096);
  DeserializationError error = deserializeJson(doc, line.c_str());
  if (error) {
    Serial.printf("[codex-display] json error: %s\n", error.c_str());
    Serial.printf("[codex-display] line: %.80s\n", line.c_str());
    renderError("串口数据异常");
    return;
  }

  if (doc["error"].is<const char *>()) {
    Serial.println("[codex-display] bridge error");
    renderError("桥接异常");
    return;
  }

  JsonVariantConst shortDoc = jsonObject(doc, "short", "s");
  JsonVariantConst longDoc = jsonObject(doc, "long", "l");
  JsonVariantConst statusDoc = jsonObject(doc, "status", "st");

  int shortPercent = jsonInt(shortDoc["remainingPercent"], jsonInt(shortDoc["r"], 0));
  int shortTimeRemainingPercent = jsonInt(shortDoc["timeRemainingPercent"], jsonInt(shortDoc["t"], 0));
  int longPercent = jsonInt(longDoc["remainingPercent"], jsonInt(longDoc["r"], 0));
  const char *shortReset = jsonString(shortDoc["reset"], nullptr);
  if (!shortReset) shortReset = jsonString(shortDoc["x"], nullptr);
  if (!shortReset) shortReset = jsonString(shortDoc["resetAscii"], "--");
  const char *shortResetRemaining = jsonString(shortDoc["resetRemaining"], nullptr);
  if (!shortResetRemaining) shortResetRemaining = jsonString(shortDoc["d"], "--");
  const char *longReset = jsonString(longDoc["reset"], nullptr);
  if (!longReset) longReset = jsonString(longDoc["x"], nullptr);
  if (!longReset) longReset = jsonString(longDoc["resetAscii"], "--");
  const char *longResetRemaining = jsonString(longDoc["resetRemaining"], nullptr);
  if (!longResetRemaining) longResetRemaining = jsonString(longDoc["d"], "--");
  const char *state = jsonString(statusDoc["state"], nullptr);
  if (!state) state = jsonString(statusDoc["s"], "idle");
  const char *statusLabel = jsonString(statusDoc["label"], nullptr);
  if (!statusLabel) statusLabel = jsonString(statusDoc["l"], nullptr);
  int statusCount = jsonInt(statusDoc["count"], jsonInt(statusDoc["c"], -1));
  const bool knownState =
    strcmp(state, "working") == 0 ||
    strcmp(state, "waiting") == 0 ||
    strcmp(state, "error") == 0 ||
    strcmp(state, "stale") == 0 ||
    strcmp(state, "idle") == 0;
  const char *displayState = knownState ? state : "idle";
  int displayCount = strcmp(displayState, "idle") == 0 ? -1 : statusCount;
  const char *homeText = jsonString(doc["homeHint"], nullptr);
  if (!homeText) homeText = jsonString(doc["h"], "点按查看详情");
  homeHint = homeText;

  updateCard(ui.shortCard, shortPercent, shortReset, shortResetRemaining);
  lv_obj_set_style_text_color(ui.shortCard.value, shortRemainingColor(shortPercent), LV_PART_MAIN);
  updateCard(ui.longCard, longPercent, longReset, longResetRemaining);
  updateEdgeProgress(shortPercent, shortTimeRemainingPercent);
  setStatusVisual(displayState, displayCount, statusLabel);
  handleCodexSessionCount(displayState, statusCount, millis());
  lastUpdateMs = millis();
  hasData = true;
  lv_label_set_text(ui.footer, homeHint.c_str());
  Serial.printf("[codex-display] payload applied reset=%s/%s\n", shortReset, longReset);
}

}  // namespace

void CodexDashboard_Init() {
  lv_style_init(&screenStyle);
  lv_style_set_bg_color(&screenStyle, lv_color_hex(0xF6F8FC));
  lv_style_set_bg_opa(&screenStyle, LV_OPA_COVER);
  lv_obj_add_style(lv_scr_act(), &screenStyle, LV_PART_MAIN);
  lv_obj_clear_flag(lv_scr_act(), LV_OBJ_FLAG_SCROLLABLE);

  lv_style_init(&cardStyle);
  lv_style_set_bg_color(&cardStyle, lv_color_hex(0xFFFFFF));
  lv_style_set_bg_opa(&cardStyle, LV_OPA_COVER);
  lv_style_set_radius(&cardStyle, 8);
  lv_style_set_pad_all(&cardStyle, 12);
  lv_style_set_border_width(&cardStyle, 1);
  lv_style_set_border_color(&cardStyle, lv_color_hex(0xE7ECF4));
  lv_style_set_shadow_width(&cardStyle, 8);
  lv_style_set_shadow_opa(&cardStyle, LV_OPA_10);
  lv_style_set_shadow_color(&cardStyle, lv_color_hex(0x9AA7B8));
  lv_style_set_shadow_ofs_y(&cardStyle, 3);

  lv_style_init(&pillStyle);
  lv_style_set_bg_color(&pillStyle, lv_color_hex(0xFFFFFF));
  lv_style_set_bg_opa(&pillStyle, LV_OPA_COVER);
  lv_style_set_radius(&pillStyle, 14);
  lv_style_set_border_width(&pillStyle, 1);
  lv_style_set_pad_left(&pillStyle, 12);
  lv_style_set_pad_right(&pillStyle, 12);

  lv_style_init(&rowStyle);
  lv_style_set_bg_color(&rowStyle, lv_color_hex(0xFFFFFF));
  lv_style_set_bg_opa(&rowStyle, LV_OPA_70);
  lv_style_set_radius(&rowStyle, 8);
  lv_style_set_pad_left(&rowStyle, 8);
  lv_style_set_pad_right(&rowStyle, 8);
  lv_style_set_border_width(&rowStyle, 1);
  lv_style_set_border_color(&rowStyle, lv_color_hex(0xE7ECF4));

  setDefaultDetailPages();

  ui.mainPage = makePage(false);
  ui.sessionsPage = makePage(true);
  initEdgeProgressArc();

  lv_obj_t *title = makeLabel(ui.mainPage, "Codex", &lv_font_montserrat_28, lv_color_hex(0x101828));
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 18);

  lv_obj_t *subtitle = makeLabel(ui.mainPage, "用量监控", &lv_font_codex_cjk_16, lv_color_hex(0x667085));
  lv_obj_align(subtitle, LV_ALIGN_TOP_MID, 0, 48);

  ui.statusPill = lv_obj_create(ui.mainPage);
  lv_obj_add_style(ui.statusPill, &pillStyle, LV_PART_MAIN);
  lv_obj_set_size(ui.statusPill, 148, 38);
  lv_obj_align(ui.statusPill, LV_ALIGN_TOP_MID, 0, 72);
  lv_obj_clear_flag(ui.statusPill, LV_OBJ_FLAG_SCROLLABLE);

  ui.statusHalo = lv_obj_create(ui.statusPill);
  lv_obj_set_size(ui.statusHalo, 18, 18);
  lv_obj_set_style_radius(ui.statusHalo, LV_RADIUS_CIRCLE, LV_PART_MAIN);
  lv_obj_set_style_border_width(ui.statusHalo, 0, LV_PART_MAIN);
  lv_obj_add_flag(ui.statusHalo, LV_OBJ_FLAG_HIDDEN);

  ui.statusDot = lv_obj_create(ui.statusPill);
  lv_obj_set_size(ui.statusDot, 16, 16);
  lv_obj_set_style_radius(ui.statusDot, LV_RADIUS_CIRCLE, LV_PART_MAIN);
  lv_obj_set_style_border_width(ui.statusDot, 0, LV_PART_MAIN);
  lv_obj_align(ui.statusDot, LV_ALIGN_LEFT_MID, 4, 0);

  ui.statusLabel = makeLabel(ui.statusPill, "空闲", &lv_font_codex_cjk_16, lv_color_hex(0x2F80ED));
  lv_obj_set_width(ui.statusLabel, 98);
  lv_label_set_long_mode(ui.statusLabel, LV_LABEL_LONG_DOT);
  lv_obj_align(ui.statusLabel, LV_ALIGN_LEFT_MID, 30, 0);

  ui.shortCard = makeUsageCard(ui.mainPage, 116, "5小时窗口", lv_color_hex(0x12B76A));
  ui.longCard = makeUsageCard(ui.mainPage, 204, "本周", lv_color_hex(0x2F80ED));

  ui.footer = makeLabel(ui.mainPage, "点按查看详情", &lv_font_codex_cjk_16, lv_color_hex(0x667085));
  lv_obj_set_width(ui.footer, 230);
  lv_obj_set_style_text_align(ui.footer, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
  lv_label_set_long_mode(ui.footer, LV_LABEL_LONG_DOT);
  lv_obj_align(ui.footer, LV_ALIGN_TOP_MID, 0, 296);

  ui.detailTitle = makeLabel(ui.sessionsPage, "详情", &lv_font_codex_cjk_24, lv_color_hex(0x101828));
  lv_obj_set_width(ui.detailTitle, 220);
  lv_obj_set_style_text_align(ui.detailTitle, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
  lv_label_set_long_mode(ui.detailTitle, LV_LABEL_LONG_DOT);
  lv_obj_align(ui.detailTitle, LV_ALIGN_TOP_MID, 0, 22);

  ui.detailHint = makeLabel(ui.sessionsPage, "点按下一页", &lv_font_codex_cjk_16, lv_color_hex(0x667085));
  lv_obj_set_width(ui.detailHint, 220);
  lv_obj_set_style_text_align(ui.detailHint, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
  lv_label_set_long_mode(ui.detailHint, LV_LABEL_LONG_DOT);
  lv_obj_align(ui.detailHint, LV_ALIGN_TOP_MID, 0, 54);

  ui.sessionSummary = makeLabel(ui.sessionsPage, "运行 0  待检 0  空闲 0", &lv_font_codex_cjk_16, lv_color_hex(0x344054));
  lv_obj_align(ui.sessionSummary, LV_ALIGN_TOP_MID, 0, 84);

  makeScheduleCurrentCard(ui.sessionsPage);

  for (int i = 0; i < SESSION_ROW_COUNT; i += 1) {
    ui.sessionRows[i] = makeSessionRow(ui.sessionsPage, 110 + i * 42);
  }

  ui.sessionEmpty = makeLabel(ui.sessionsPage, "暂无会话", &lv_font_codex_cjk_16, lv_color_hex(0x667085));
  lv_obj_align(ui.sessionEmpty, LV_ALIGN_TOP_MID, 0, 178);

  ui.touchLayer = lv_obj_create(lv_scr_act());
  lv_obj_remove_style_all(ui.touchLayer);
  lv_obj_set_size(ui.touchLayer, 360, 360);
  lv_obj_align(ui.touchLayer, LV_ALIGN_CENTER, 0, 0);
  lv_obj_add_flag(ui.touchLayer, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_clear_flag(ui.touchLayer, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_add_event_cb(ui.touchLayer, touchEvent, LV_EVENT_PRESSED, nullptr);
  lv_obj_add_event_cb(ui.touchLayer, touchEvent, LV_EVENT_RELEASED, nullptr);
  lv_obj_add_event_cb(ui.touchLayer, touchEvent, LV_EVENT_CLICKED, nullptr);
  lv_obj_add_event_cb(ui.touchLayer, touchEvent, LV_EVENT_GESTURE, nullptr);

  initBle();

  renderWaiting();
}

void CodexDashboard_PollSerial() {
  while (Serial.available() > 0) {
    processIncomingByte(static_cast<char>(Serial.read()));
  }

  processBleQueueBytes();
}

void CodexDashboard_Tick() {
  if (!hasData) return;

  uint32_t nowMs = millis();
  uint32_t ageMs = nowMs - lastUpdateMs;
  if (ageMs > DISPLAY_SLEEP_AFTER_MS) {
    setDisplaySleeping(true);
  }
  if (isDisplaySleeping) return;

  if (ageMs > STALE_AFTER_MS && lastState != "stale") {
    setStatusVisual("stale");
  }

  handleAutoPageTick(nowMs);

  char footer[96];
  snprintf(footer, sizeof(footer), "%s | %lu秒", homeHint.c_str(), static_cast<unsigned long>(ageMs / 1000));
  lv_label_set_text(ui.footer, footer);
}
