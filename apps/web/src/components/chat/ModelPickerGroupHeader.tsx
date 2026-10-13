import { type ProviderDriverKind } from "@t3tools/contracts";
import { memo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronRightIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";

export const ModelPickerGroupHeader = memo(function ModelPickerGroupHeader(props: {
  index: number;
  value: string;
  title: string;
  driverKind: ProviderDriverKind;
  slugPlaceholder: string;
  isExpanded: boolean;
  onAddSlug: (slug: string) => string | null;
  onOpenSettings: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  const stopRowSelect = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const submitSlug = () => {
    const message = props.onAddSlug(slug);
    if (message) {
      setError(message);
      return;
    }
    setSlug("");
    setError(null);
    setAdding(false);
  };

  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={props.value}
      aria-expanded={props.isExpanded}
      className="group w-full cursor-pointer rounded-md px-2 py-1.5"
      contentClassName="flex w-full flex-col gap-1.5"
    >
      <div className="flex w-full items-center gap-2">
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", props.isExpanded && "rotate-90")}
        />
        <ProviderInstanceIcon
          driverKind={props.driverKind}
          displayName={props.title}
          className="size-4"
          iconClassName="size-3.5"
        />
        <div className="min-w-0 flex-1 truncate text-xs font-medium leading-snug">{props.title}</div>
        <div className="flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="-mr-0.5 size-6 text-muted-foreground/80 hover:text-foreground"
                  aria-label={`Add model slug to ${props.title}`}
                  onClick={(event) => {
                    stopRowSelect(event);
                    setAdding((open) => !open);
                    setError(null);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <PlusIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup side="top">Add model slug</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="-mr-1 size-6 text-muted-foreground/80 hover:text-foreground"
                  aria-label={`Provider settings for ${props.title}`}
                  onClick={(event) => {
                    stopRowSelect(event);
                    props.onOpenSettings();
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup side="top">Provider settings</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {adding ? (
        <div
          className="flex w-full flex-col gap-1 pl-6"
          onClick={stopRowSelect}
          onPointerDown={stopRowSelect}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Input
            size="sm"
            value={slug}
            spellCheck={false}
            placeholder={props.slugPlaceholder}
            aria-label={`Model slug for ${props.title}`}
            onChange={(event) => {
              setSlug(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                submitSlug();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setAdding(false);
                setError(null);
              }
            }}
          />
          {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </ComboboxItem>
  );
});
