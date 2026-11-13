import { useState } from "react";
import { Text } from "react-native";
import { router } from "expo-router";
import { findCustomers } from "@masalapos/cafe-data";
import { useData } from "../../db/provider";
import { color, type } from "../../theme/tokens";
import { Button, Field, ListRow, Screen } from "../../ui";

/** Saved customers, searchable by phone or name. */
export default function CustomersScreen() {
  const [query, setQuery] = useState("");
  const found = useData((d) => findCustomers(d, query, 200));
  return (
    <Screen title="Customers" edges={["top", "bottom"]}
      actions={<Button label="Add" icon="plus" onPress={() => router.push("/customer/new")} />}>
      <Field label="Phone or name" value={query} onChangeText={setQuery} placeholder="98765 or Asha" />
      {found.map((c) => <ListRow key={c.id} title={c.name} subtitle={c.phone} onPress={() => router.push(`/customer/${c.id}`)} />)}
      {!found.length ? (
        <Text style={[type.body, { color: color.onSurfaceMuted }]}>
          {query.trim() ? "No customer matches." : "No customers yet. Add one here or from the cart."}
        </Text>
      ) : null}
    </Screen>
  );
}
