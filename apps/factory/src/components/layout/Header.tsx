import { useState } from "react";
import type { FactoryOverviewSnapshot } from "@t3tools/contracts/factory";
import { Layers, ListTree, Menu, Moon, Plus, Server, Star, Sun, X } from "lucide-react";
import {
  Badge,
  Button,
  CounterBadge,
  Tab,
  TabList,
  Tooltip,
  Toolbar,
} from "../../design-system/actions";
import {
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  OverlayDrawer,
  Select,
} from "../../design-system/forms";
import { useT3Store } from "../../store/useT3Store";
import styles from "./Header.module.css";

export type MobileSection = "pinned" | "all";

interface HeaderProps {
  readonly currentView: "overview" | "nodes";
  readonly setCurrentView: (view: "overview" | "nodes") => void;
  readonly mobileSection: MobileSection;
  readonly setMobileSection: (section: MobileSection) => void;
  readonly snapshot: FactoryOverviewSnapshot;
}

const mobileTabs = [
  { value: "pinned", label: "Pinned", icon: <Star size={18} aria-hidden="true" /> },
  { value: "all", label: "All", icon: <ListTree size={18} aria-hidden="true" /> },
  { value: "nodes", label: "Nodes", icon: <Server size={18} aria-hidden="true" /> },
] as const;

export function Header({
  currentView,
  setCurrentView,
  mobileSection,
  setMobileSection,
  snapshot,
}: HeaderProps) {
  const theme = useT3Store((state) => state.theme);
  const toggleTheme = useT3Store((state) => state.toggleTheme);
  const setShowNewThreadModal = useT3Store((state) => state.setShowNewThreadModal);
  const activeEnvironmentFilter = useT3Store((state) => state.activeEnvironmentFilter);
  const setActiveEnvironmentFilter = useT3Store((state) => state.setActiveEnvironmentFilter);
  const setSelectedTarget = useT3Store((state) => state.setSelectedTarget);
  const setViewMode = useT3Store((state) => state.setViewMode);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const onlineSources = snapshot.environments.filter(
    (environment) => environment.enabled && environment.state === "online",
  ).length;
  const activeThreads = snapshot.threads.filter(
    (thread) => thread.classification === "active",
  ).length;
  const waitingThreads = snapshot.threads.filter(
    (thread) => thread.classification === "waiting",
  ).length;
  const staleSources = snapshot.sourceFreshness.filter((source) => source.state !== "fresh").length;

  const renderNavigation = () => (
    <TabList
      className={styles.navigationTabs}
      size="small"
      selectedValue={currentView}
      onTabSelect={(_, data) => {
        if (data.value === "overview" || data.value === "nodes") setCurrentView(data.value);
        setMobileMenuOpen(false);
      }}
      aria-label="Main navigation"
    >
      <Tab value="overview" icon={<Layers size={16} aria-hidden="true" />}>
        Overview
      </Tab>
      <Tab value="nodes" icon={<Server size={16} aria-hidden="true" />}>
        Serve Nodes <CounterBadge count={snapshot.environments.length} />
      </Tab>
    </TabList>
  );

  const renderMobileNavigation = () => (
    <TabList
      className={styles.mobileTabs}
      appearance="pill"
      selectedValue={currentView === "nodes" ? "nodes" : mobileSection}
      onTabSelect={(_, data) => {
        if (data.value === "nodes") {
          setCurrentView("nodes");
          return;
        }
        if (data.value === "pinned" || data.value === "all") {
          setMobileSection(data.value);
          setCurrentView("overview");
          setSelectedTarget(null);
          setViewMode("dashboard");
        }
      }}
      aria-label="Dashboard sections"
    >
      {mobileTabs.map((tab) => (
        <Tooltip key={tab.value} content={tab.label} relationship="label">
          <Tab value={tab.value} icon={tab.icon} className={styles.mobileTab} />
        </Tooltip>
      ))}
    </TabList>
  );

  const renderSourceFilter = () => (
    <Select
      className={styles.nodeSelect}
      value={activeEnvironmentFilter}
      onChange={(_, data) => setActiveEnvironmentFilter(data.value)}
      aria-label="Filter by source"
    >
      <option value="all">All sources ({snapshot.environments.length})</option>
      {snapshot.environments.map((environment) => (
        <option key={environment.environmentId} value={environment.environmentId}>
          {environment.label}
        </option>
      ))}
    </Select>
  );

  const themeAction = (
    <Tooltip
      content={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      relationship="label"
    >
      <Button
        appearance="subtle"
        icon={theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        aria-label="Toggle theme"
        onClick={toggleTheme}
      />
    </Tooltip>
  );

  const launchAction = (
    <Button
      appearance="primary"
      icon={<Plus size={16} aria-hidden="true" />}
      onClick={() => {
        setMobileMenuOpen(false);
        setShowNewThreadModal(true);
      }}
    >
      New Session
    </Button>
  );

  return (
    <header className={styles.header}>
      <div className={styles.headerMain}>
        <div className={styles.brandAndStatus}>
          <nav className={styles.mobileNavigation} aria-label="Sections">
            {renderMobileNavigation()}
          </nav>
          <div className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true">
              T3
            </span>
            <span className={styles.brandName}>T3 Factory</span>
          </div>
          <div className={styles.stats} aria-label="Factory status">
            <Badge className={styles.secondaryStat} color="success" dot>
              {onlineSources}/{snapshot.environments.length} online
            </Badge>
            <Badge className={styles.secondaryStat} color="info" dot>
              {activeThreads} active
            </Badge>
            {waitingThreads > 0 ? (
              <Badge color="warning" dot>
                {waitingThreads} waiting
              </Badge>
            ) : null}
            {staleSources > 0 ? (
              <Badge color="warning" appearance="outline">
                {staleSources} sources not fresh
              </Badge>
            ) : null}
          </div>
        </div>
        <nav className={styles.desktopNavigation} aria-label="Main navigation">
          {renderNavigation()}
          {renderSourceFilter()}
        </nav>
        <Toolbar className={styles.desktopActions} aria-label="Factory actions">
          {launchAction}
          {themeAction}
        </Toolbar>
        <Button
          className={styles.menuTrigger}
          appearance="subtle"
          icon={mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
          aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMobileMenuOpen((open) => !open)}
        />
      </div>
      <OverlayDrawer
        className={styles.mobileDrawer}
        open={mobileMenuOpen}
        onOpenChange={(_, data) => setMobileMenuOpen(data.open)}
        size="small"
        position="end"
      >
        <DrawerHeader>
          <DrawerHeaderTitle>Factory controls</DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody className={styles.drawerBody}>
          <div className={styles.drawerStats} aria-label="Factory status">
            <Badge size="small" color="success" dot>
              {onlineSources}/{snapshot.environments.length} online
            </Badge>
            <Badge size="small" color="info" dot>
              {activeThreads} active
            </Badge>
            {staleSources > 0 ? (
              <Badge size="small" color="warning">
                {staleSources} not fresh
              </Badge>
            ) : null}
          </div>
          <nav className={styles.drawerNavigation} aria-label="Main navigation">
            {renderNavigation()}
          </nav>
          <Field label="Active source">{renderSourceFilter()}</Field>
          <Toolbar className={styles.drawerActions} aria-label="Factory actions">
            {launchAction}
            {themeAction}
          </Toolbar>
        </DrawerBody>
      </OverlayDrawer>
    </header>
  );
}
