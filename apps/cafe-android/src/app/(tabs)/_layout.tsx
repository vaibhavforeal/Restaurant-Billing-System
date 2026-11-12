import { Redirect } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import { getCafe } from "@masalapos/cafe-data";
import { useData } from "../../db/provider";
import { color, type } from "../../theme/tokens";
import { Icon, useLayout, type IconName } from "../../ui";

const TABS: Array<{ name: string; title: string; icon: IconName }> = [
  { name: "bill", title: "Bill", icon: "bill" },
  { name: "bills", title: "Bills", icon: "bills" },
  { name: "reports", title: "Reports", icon: "reports" },
  { name: "menu", title: "Menu", icon: "menu" },
  { name: "more", title: "More", icon: "more" },
];

/** Bottom tabs on a phone, a side rail from 840 dp. */
export default function TabsLayout() {
  const hasCafe = useData((db) => getCafe(db) !== null);
  const { tablet } = useLayout();
  if (!hasCafe) return <Redirect href="/first-run" />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarPosition: tablet ? "left" : "bottom",
        tabBarVariant: tablet ? "material" : "uikit",
        tabBarActiveTintColor: color.primaryInk,
        tabBarInactiveTintColor: color.onSurfaceMuted,
        tabBarActiveBackgroundColor: tablet ? color.primaryContainer : color.surface,
        tabBarLabelStyle: { ...type.caption, fontWeight: "600" },
        tabBarStyle: { backgroundColor: color.surface, borderColor: color.outlineVariant, minHeight: 64 },
        tabBarItemStyle: { minHeight: 48 },
      }}
    >
      {TABS.map((t) => (
        <Tabs.Screen key={t.name} name={t.name} options={{ title: t.title, tabBarIcon: ({ color: tint }) => <Icon name={t.icon} tint={tint} /> }} />
      ))}
    </Tabs>
  );
}
