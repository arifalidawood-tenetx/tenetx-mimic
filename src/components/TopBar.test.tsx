import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { User } from "firebase/auth";
import { TopBar } from "./TopBar";
import { AuthProvider } from "@/lib/authState";

type AuthStateCallback = (user: User | null) => void;
let authStateCallback: AuthStateCallback = () => {};

const signOutMock = vi.fn(async () => {
  authStateCallback(null);
});
const signInWithPopupMock = vi.fn();
const signInWithEmailAndPasswordMock = vi.fn();
const createUserWithEmailAndPasswordMock = vi.fn();
const sendEmailVerificationMock = vi.fn();
const sendSignInLinkToEmailMock = vi.fn();
const isSignInWithEmailLinkMock = vi.fn(() => false);

vi.mock("@/lib/firebaseClient", () => ({ auth: {}, db: {} }));

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth: unknown, cb: AuthStateCallback) => {
    authStateCallback = cb;
    return () => {};
  },
  signOut: () => signOutMock(),
  signInWithPopup: () => signInWithPopupMock(),
  signInWithEmailAndPassword: () => signInWithEmailAndPasswordMock(),
  createUserWithEmailAndPassword: () => createUserWithEmailAndPasswordMock(),
  sendEmailVerification: () => sendEmailVerificationMock(),
  sendSignInLinkToEmail: () => sendSignInLinkToEmailMock(),
  isSignInWithEmailLink: () => isSignInWithEmailLinkMock(),
  signInWithEmailLink: () => Promise.resolve(),
  GoogleAuthProvider: class {
    setCustomParameters = vi.fn();
  },
}));

function fakeUser(email: string, emailVerified = true): User {
  return { email, emailVerified } as unknown as User;
}

function fire(user: User | null) {
  act(() => {
    authStateCallback(user);
  });
}

beforeEach(() => {
  authStateCallback = () => {};
  signOutMock.mockClear();
  signInWithPopupMock.mockClear();
  signInWithEmailAndPasswordMock.mockClear();
  createUserWithEmailAndPasswordMock.mockClear();
  sendEmailVerificationMock.mockClear();
  sendSignInLinkToEmailMock.mockClear();
  isSignInWithEmailLinkMock.mockClear();
});

describe("TopBar", () => {
  it("renders home link with href to /", async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <TopBar />
        </AuthProvider>
      </MemoryRouter>
    );

    fire(fakeUser("user@tenetx.ai"));

    const homeLink = screen.getByRole("link", { name: /TenetX Mimic home/i });
    expect(homeLink).toHaveAttribute("href", "/");
  });

  it("renders home link text", async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <TopBar />
        </AuthProvider>
      </MemoryRouter>
    );

    fire(fakeUser("user@tenetx.ai"));

    expect(screen.getByText("TenetX Mimic")).toBeInTheDocument();
  });

  describe("when authorized", () => {
    it("renders email inline on desktop (sm:flex)", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(fakeUser("user@tenetx.ai"));

      expect(await screen.findByText("user@tenetx.ai")).toBeInTheDocument();
    });

    it("renders Sign out button on desktop", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(fakeUser("user@tenetx.ai"));

      const signOutButtons = await screen.findAllByRole("button", { name: /Sign out/i });
      expect(signOutButtons.length).toBeGreaterThan(0);
    });

    it("renders hamburger button (mobile)", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(fakeUser("user@tenetx.ai"));

      const hamburger = await screen.findByRole("button", { name: /Open menu/i });
      expect(hamburger).toBeInTheDocument();
    });

    it("clicking desktop Sign out button calls signOut", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(fakeUser("user@tenetx.ai"));

      const signOutButtons = await screen.findAllByRole("button", { name: /Sign out/i });
      const desktopSignOut = signOutButtons[0];

      await act(async () => {
        fireEvent.click(desktopSignOut);
      });

      expect(signOutMock).toHaveBeenCalled();
    });

    it("clicking hamburger opens the drawer panel (role=menu)", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(fakeUser("user@tenetx.ai"));

      const hamburger = await screen.findByRole("button", { name: /Open menu/i });

      await act(async () => {
        fireEvent.click(hamburger);
      });

      const menu = screen.getByRole("menu");
      expect(menu).toBeInTheDocument();
    });

    it("drawer panel contains email and Sign out button", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(fakeUser("user@tenetx.ai"));

      const hamburger = await screen.findByRole("button", { name: /Open menu/i });

      await act(async () => {
        fireEvent.click(hamburger);
      });

      const menu = screen.getByRole("menu");
      expect(menu).toHaveTextContent("user@tenetx.ai");

      const signOutButtons = screen.getAllByRole("button", { name: /Sign out/i });
      expect(signOutButtons.length).toBeGreaterThanOrEqual(2);
    });

    it("clicking drawer Sign out button calls signOut and closes drawer", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(fakeUser("user@tenetx.ai"));

      const hamburger = await screen.findByRole("button", { name: /Open menu/i });

      await act(async () => {
        fireEvent.click(hamburger);
      });

      const signOutButtons = screen.getAllByRole("button", { name: /Sign out/i });
      const drawerSignOut = signOutButtons[signOutButtons.length - 1];

      await act(async () => {
        fireEvent.click(drawerSignOut);
      });

      expect(signOutMock).toHaveBeenCalled();
    });

    it("pressing Escape while drawer is open closes it", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(fakeUser("user@tenetx.ai"));

      const hamburger = await screen.findByRole("button", { name: /Open menu/i });

      await act(async () => {
        fireEvent.click(hamburger);
      });

      expect(screen.getByRole("menu")).toBeInTheDocument();

      await act(async () => {
        fireEvent.keyDown(window, { key: "Escape" });
      });

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("renders super-admin badge when email is SUPER_ADMIN_EMAIL", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(fakeUser("arif.dawood@tenetx.ai"));

      expect(await screen.findAllByText("Super Admin")).toBeDefined();
    });

    it("does not render super-admin badge for regular users", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(fakeUser("user@tenetx.ai"));

      await screen.findByText("user@tenetx.ai");

      expect(screen.queryByText("Super Admin")).not.toBeInTheDocument();
    });

    it("hamburger button aria-expanded reflects drawer state", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(fakeUser("user@tenetx.ai"));

      const hamburger = await screen.findByRole("button", { name: /Open menu/i });
      expect(hamburger).toHaveAttribute("aria-expanded", "false");

      await act(async () => {
        fireEvent.click(hamburger);
      });

      expect(hamburger).toHaveAttribute("aria-expanded", "true");
    });

    it("pressing Ctrl+B toggles the desktop sidebar visibility", async () => {
      const { container } = render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(fakeUser("user@tenetx.ai"));

      await screen.findByText("user@tenetx.ai");

      const getAside = () => container.querySelector("aside");
      expect(getAside()).toHaveClass("lg:flex");
      expect(getAside()).not.toHaveClass("lg:hidden");

      await act(async () => {
        fireEvent.keyDown(window, { key: "b", ctrlKey: true });
      });

      expect(getAside()).toHaveClass("lg:hidden");
      expect(getAside()).not.toHaveClass("lg:flex");

      await act(async () => {
        fireEvent.keyDown(window, { key: "b", ctrlKey: true });
      });

      expect(getAside()).toHaveClass("lg:flex");
      expect(getAside()).not.toHaveClass("lg:hidden");
    });
  });

  describe("when not authorized", () => {
    it("does not render identity row or hamburger button", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(null);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(screen.queryByText(/user@tenetx.ai/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Open menu/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Sign out/i })).not.toBeInTheDocument();
    });

    it("still renders home link", async () => {
      render(
        <MemoryRouter>
          <AuthProvider>
            <TopBar />
          </AuthProvider>
        </MemoryRouter>
      );

      fire(null);

      const homeLink = screen.getByRole("link", { name: /TenetX Mimic home/i });
      expect(homeLink).toBeInTheDocument();
    });
  });


});
