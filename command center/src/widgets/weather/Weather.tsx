import type { WidgetProps } from "@/core/widgets/types";
import { WeatherPanel } from "@/features/weather/WeatherPanel";

/** Living Weather: the WeatherPanel at the widget's size (picker at every width; forecast from h = 3). */
export default function Weather({ size }: WidgetProps) {
  return <WeatherPanel layout="widget" size={size} />;
}
