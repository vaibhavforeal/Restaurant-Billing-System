import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, elevation, radius, space, touch, type } from "../theme/tokens";
import { Icon } from "./Icon";

/** A bottom sheet for short tasks (a variant, a custom item, a discount). Tapping outside or Back closes it. */
export function Sheet({ visible, title, onClose, children, footer }: {
  visible: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="height" style={styles.fill}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]}>
          <View style={styles.header}>
            <Text style={[type.title, styles.title]} accessibilityRole="header">{title}</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={styles.close}>
              <Icon name="close" />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>{children}</ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "flex-end" },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: color.scrim },
  sheet: { maxHeight: "90%", alignSelf: "center", width: "100%", maxWidth: 640, backgroundColor: color.surface,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, ...elevation.sheet },
  header: { flexDirection: "row", alignItems: "center", paddingLeft: space.lg, paddingRight: space.xs, paddingTop: space.xs },
  title: { flex: 1, color: color.onSurface },
  close: { width: touch.min, height: touch.min, alignItems: "center", justifyContent: "center" },
  body: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.md },
  footer: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm },
});
