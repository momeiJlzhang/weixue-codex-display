#include "CodexDashboard.h"
#include "Display_ST77916.h"
#include "I2C_Driver.h"
#include "LVGL_Driver.h"
#include "TCA9554PWR.h"

void setup() {
  Serial.setRxBufferSize(2048);
  Serial.begin(115200);
  delay(300);

  I2C_Init();
  TCA9554PWR_Init(0x00);
  Backlight_Init();
  LCD_Init();
  Lvgl_Init();
  CodexDashboard_Init();

  Serial.println("[codex-display] ready");
}

void loop() {
  CodexDashboard_PollSerial();
  CodexDashboard_Tick();
  Lvgl_Loop();
  vTaskDelay(pdMS_TO_TICKS(5));
}
