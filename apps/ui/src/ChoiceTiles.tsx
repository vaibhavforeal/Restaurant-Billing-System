import { Children, isValidElement, useId, useState, type HTMLAttributes, type ReactNode } from "react";
import "./choice-tiles.css";

type Choice = { value: string; label: string; disabled: boolean; group: string };
type ChoiceProps = Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "children"> & {
  value: string | number;
  onChange: (value: string) => void;
  children?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  searchable?: boolean;
};

function textContent(children: ReactNode): string {
  return Children.toArray(children).map(child => isValidElement<{ children?: ReactNode }>(child)
    ? textContent(child.props.children) : String(child)).join("");
}

// Keep option declarations next to their existing screen data. Only radios render in the DOM.
function readChoices(children: ReactNode, group = "", disabled = false): Choice[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; label?: string; disabled?: boolean }>(child)) return [];
    const props = child.props;
    if (child.type === "option") return [{ value: String(props.value ?? textContent(props.children)),
      label: props.label ?? textContent(props.children), disabled: disabled || !!props.disabled, group }];
    return readChoices(props.children, child.type === "optgroup" ? props.label ?? "" : group, disabled || !!props.disabled);
  });
}

export function ChoiceTiles({ value, onChange, children, disabled = false, required = false, name, searchable: searchEnabled, className = "", ...props }: ChoiceProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const choices = readChoices(children);
  const selected = String(value);
  const term = query.trim().toLocaleLowerCase();
  const matches = (choice: Choice) => `${choice.label} ${choice.group}`.toLocaleLowerCase().includes(term);
  const groups = [...new Set(choices.map(choice => choice.group))];
  const searchable = searchEnabled ?? choices.length > 8;
  const label = props["aria-label"] ?? "Choices";
  return <div {...props} className={`choice-tiles ${className}`} role="radiogroup" aria-disabled={disabled} aria-required={required}>
    {searchable && <input className="choice-search" type="search" aria-label={`Find in ${label}`} placeholder="Find an option…"
      value={query} disabled={disabled} onChange={event => setQuery(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} />}
    <div className={`choice-options${searchable ? " choice-options-scroll" : ""}`}>
      {groups.map(group => <div className="choice-group" key={group} hidden={searchable && !choices.some(choice => choice.group === group && (matches(choice) || choice.value === selected))}>
        {group && <span className="choice-group-title">{group}</span>}
        {choices.filter(choice => choice.group === group).map(choice => {
          const placeholder = required && choice.value === "";
          const checked = !placeholder && selected === choice.value;
          return <label className="choice-tile" key={choice.value} hidden={searchable && !matches(choice) && !checked}>
            <input type="radio" name={name ?? id} disabled={disabled || choice.disabled || placeholder} required={required}
              checked={checked} value={choice.value} aria-describedby={props["aria-describedby"]} aria-invalid={props["aria-invalid"]}
              onChange={() => onChange(choice.value)} />
            <span className="choice-tile-face"><span aria-hidden="true" className="choice-mark">{checked ? "✓" : ""}</span>{choice.label}</span>
          </label>;
        })}
      </div>)}
    </div>
    {searchable && term && !choices.some(matches) && <span className="choice-empty" role="status">No matching options. Clear the search to see all choices.</span>}
  </div>;
}
