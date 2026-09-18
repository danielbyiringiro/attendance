import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2 } from "lucide-react";
import { useActiveClass } from "@/lib/classContext";
import type { ClassTab } from "@/lib/taNavigation";
import Sessions from "@/components/ta/sections/Sessions";
import ClassSettings from "@/components/ta/sections/ClassSettings";

interface ClassAreaProps {
  tab: ClassTab;
  onTabChange: (tab: ClassTab) => void;
  onOpenAllClasses: () => void;
}

/**
 * Everything about the class chosen in the switcher, in one place.
 *
 * Setting up a class used to take three sidebar tabs: Classes for its details,
 * people and deletion, Schedule for when it meets, and Class Sessions for its
 * sessions, timing and display link. They are tabs of one page now — Sessions
 * for daily use, Weekly pattern for when it meets, Settings for the rest — so
 * the sidebar holds five items instead of seven.
 */
const ClassArea = ({ tab, onTabChange, onOpenAllClasses }: ClassAreaProps) => {
  const { activeClass, isLoading } = useActiveClass();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if (!activeClass) {
    return (
      <Card className="border-2 border-dashed">
        <CardContent className="space-y-3 pt-6 text-center">
          <div>
            <p className="font-medium">No class selected</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose one in the class switcher, or create one from All classes.
            </p>
          </div>
          <Button variant="outline" onClick={onOpenAllClasses}>
            All classes
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as ClassTab)}
      className="space-y-6"
    >
      <TabsList>
        <TabsTrigger value="sessions">Sessions</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>

      <TabsContent value="sessions" className="mt-0">
        <Sessions />
      </TabsContent>
      <TabsContent value="settings" className="mt-0">
        <ClassSettings onOpenAllClasses={onOpenAllClasses} />
      </TabsContent>
    </Tabs>
  );
};

export default ClassArea;
