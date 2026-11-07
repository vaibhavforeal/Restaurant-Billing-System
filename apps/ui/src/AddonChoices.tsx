import { activeAddonGroups, addonHint } from "./addon-cart";
import type { AddonPickerGroup, AddonSnapshot } from "./types";
import { paiseToRupees } from "./money";
import "./combo-choices.css";
import "./addons.css";

export function AddonChoices({ groups, picks, onChange, disabled = false }: {
  groups: AddonPickerGroup[]; picks: string[]; onChange: (picks: string[]) => void; disabled?: boolean;
}) {
  return <div className="combo-choices">{activeAddonGroups(groups).map((group) => {
    const count = group.options.filter((option) => picks.includes(option.id)).length;
    return <fieldset key={group.id} className="combo-slot" disabled={disabled}>
      <legend><span>{group.name}</span><small>{addonHint(group)}</small></legend>
      {group.options.map((option) => {
        const checked = picks.includes(option.id);
        return <label key={option.id} className={`combo-option${checked ? " selected" : ""}${option.unavailable ? " addon-unavailable" : ""}`}>
          <input type="checkbox" checked={checked} disabled={!!option.unavailable || (!checked && (count >= group.maxPicks || picks.length >= 40))}
            onChange={() => onChange(checked ? picks.filter((id) => id !== option.id) : [...picks, option.id])} />
          <span>{option.name}{option.unavailable && <small> · Sold out or unavailable</small>}</span><small>₹{paiseToRupees(option.pricePaise)}</small>
        </label>;
      })}
    </fieldset>;
  })}</div>;
}

export function AddonLines({ addons, qty = 1 }: { addons?: AddonSnapshot[] | undefined; qty?: number }) {
  if (!addons?.length) return null;
  return <span className="addon-lines">{addons.map((addon, index) => <span className="addon-snapshot" key={index}><span>+ {addon.name}</span><span>₹{paiseToRupees(addon.pricePaise * qty)}</span></span>)}</span>;
}
