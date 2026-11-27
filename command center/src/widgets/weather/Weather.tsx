import { useEffect } from "react";
import type { WidgetProps } from "@/core/widgets/types";
import { WeatherPanel } from "@/features/weather/WeatherPanel";
import { useWeather } from "@/features/weather/weather-store";

/** Living Weather: the WeatherPanel at the widget's size (picker at every width; forecast from h = 3). */
export default function Weather({ size, setBadge }: WidgetProps) {
  // App-icon badge: the temperature (section pass).
  const now = useWeather().now;
  const temp = now ? `${Math.round(now.tempC)}°` : null;
  useEffect(() => setBadge?.(temp), [temp, setBadge]);
  return <WeatherPanel layout="widget" size={size} />;
}
