import type { ComponentProps } from "react";
import type { IconButton } from "@board/components/base/buttons/icon-button";

/** BoardUI's icon prop type is narrower than Remix Icon's component type. Pass Remix icons through this one adapter. */
export type BoardIcon = ComponentProps<typeof IconButton>["icon"];
export const asIcon = (icon: unknown): BoardIcon => icon as BoardIcon;
