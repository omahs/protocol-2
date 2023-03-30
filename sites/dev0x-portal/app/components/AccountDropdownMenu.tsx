import { forwardRef } from 'react';
import { Form, Link } from '@remix-run/react';
import { twMerge } from 'tailwind-merge';
import { LinkExternal } from '../icons/LinkExternal';
import * as DropdownMenu from './DropdownMenu';

import type { ClientUser } from '../types';
import type { ElementRef, ComponentPropsWithRef, ComponentPropsWithoutRef } from 'react';

export const Root = DropdownMenu.Root;
export const Trigger = DropdownMenu.Trigger;

const ExternalLinkDropdownItem = forwardRef<HTMLAnchorElement, ComponentPropsWithoutRef<'a'>>(
    function ExternalLinkDropdownItem({ children, className, ...other }, forwardedRef) {
        return (
            <a
                target="_blank"
                rel="noreferrer"
                className={twMerge('flex items-center justify-between', className)}
                {...other}
                ref={forwardedRef}
            >
                <span>{children}</span>
                <LinkExternal strokeWidth={3} width={16} height={16} color="#18181B" /> {/* grey-900*/}
            </a>
        );
    },
);

type AccountDropdownContentProps = ComponentPropsWithRef<typeof DropdownMenu.Content> & {
    children?: never;
    userEmail: string;
    userTeam?: string;
};

export const Content = forwardRef<ElementRef<typeof DropdownMenu.Content>, AccountDropdownContentProps>(
    function Content({ userEmail, userTeam, ...other }, forwardedRef) {
        return (
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    sideOffset={5}
                    collisionPadding={20}
                    {...other}
                    ref={forwardedRef}
                    className="min-w-[250px]"
                >
                    <DropdownMenu.Item asChild disabled>
                        <div className="flex flex-col justify-start">
                            <span className="text-grey-800 font-sans text-base">{userEmail}</span>
                            {userTeam && <span className="text-grey-500 font-sans text-sm">{userTeam}</span>}
                        </div>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item asChild>
                        <Link to={`/account/settings`} className="space-y-0">
                            Settings
                        </Link>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item asChild>
                        <ExternalLinkDropdownItem href="https://docs.0x.org/">Docs</ExternalLinkDropdownItem>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item asChild>
                        <ExternalLinkDropdownItem href="https://docs.0x.org/">Help</ExternalLinkDropdownItem>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item asChild>
                        <ExternalLinkDropdownItem href="https://explorer.0x.org/">0x Explorer</ExternalLinkDropdownItem>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <Form action="/logout" method="post">
                        <DropdownMenu.Item onSelect={(e) => e.preventDefault()} asChild>
                            <button type="submit" className="mt-0 inline-block w-full">
                                Log out
                            </button>
                        </DropdownMenu.Item>
                    </Form>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        );
    },
);